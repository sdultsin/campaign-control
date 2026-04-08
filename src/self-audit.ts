import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  RunSummary, AuditResult, AuditCheckResult, AuditVerdict,
  AuditCheckStatus, AuditCheckSeverity, AuditConfigSnapshot,
  KvSummary, TrailingAvg,
} from './types';
import { PILOT_CMS, DRY_RUN_CMS, WORKSPACE_CONFIGS, MAX_KILLS_PER_RUN, RESCAN_MAX_WINDOW_HOURS, WINNER_MIN_OPPS, SLACK_SUPPRESSED } from './config';
import { WORKER_VERSION } from './version';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runSelfAudit(
  sb: SupabaseClient,
  kv: KVNamespace,
  runSummary: RunSummary,
  slackToken: string,
  auditChannel: string,
  dashboardBaseUrl: string,
): Promise<void> {
  const auditStart = Date.now();

  // Build config snapshot from current config
  const configSnapshot = buildConfigSnapshot();

  // Fetch trailing data (last 3 run_summaries + last audit_results)
  const trailingRuns = await fetchTrailingRuns(sb, runSummary.timestamp);
  const priorAudit = await fetchPriorAudit(sb);
  const trailingAvg = computeTrailingAvg(trailingRuns, configSnapshot, priorAudit);

  // Fetch prior run for deltas
  const priorRun = trailingRuns[0] ?? null;

  // Fetch KV summary (used by kv_integrity check and stored in result)
  const kvSummary = await buildKvSummary(kv);

  // Run all 13 checks
  const checks: AuditCheckResult[] = [];
  checks.push(await checkRunCompletion(sb, runSummary));
  checks.push(await checkKillIntegrity(sb));
  checks.push(await checkDashboardDedup(sb));
  checks.push(checkErrorRegression(runSummary, trailingAvg));
  checks.push(await checkGhostAudit(kv, runSummary));
  checks.push(await checkThresholdMath(sb));
  checks.push(await checkKvIntegrity(kv, kvSummary));
  checks.push(await checkSupabaseSync(sb, runSummary));
  checks.push(await checkSlackDelivery(sb));
  checks.push(checkLeadsMonitoring(runSummary));
  checks.push(await checkWinnerDetection(sb));
  checks.push(checkCrossRunConsistency(runSummary, trailingAvg));
  checks.push(await checkDailySnapshot(sb));

  // Compute verdict
  const verdict = computeVerdict(checks);

  // Build audit result
  const auditResult = buildAuditResult(
    runSummary, checks, verdict, configSnapshot, kvSummary, trailingAvg, priorRun, auditStart,
  );

  // Write to Supabase
  await writeAuditResult(sb, auditResult);

  // Cleanup old rows
  await cleanupOldAuditResults(sb);

  // Post Slack digest
  await postAuditDigest(slackToken, auditChannel, auditResult, dashboardBaseUrl);
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

function makeCheck(
  name: string,
  severity: AuditCheckSeverity,
  status: AuditCheckStatus,
  expected: string,
  actual: string,
  detail: string | null = null,
): AuditCheckResult {
  return { name, status, expected, actual, detail, severity };
}

const thirtyMinAgo = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Check 1: run_completion
// ---------------------------------------------------------------------------

async function checkRunCompletion(sb: SupabaseClient, runSummary: RunSummary): Promise<AuditCheckResult> {
  try {
    const { data } = await sb.from('cc_run_summaries')
      .select('worker_version, campaigns_evaluated')
      .gt('created_at', thirtyMinAgo())
      .order('created_at', { ascending: false })
      .limit(1);

    const row = data?.[0];
    if (!row) {
      return makeCheck('run_completion', 'CRITICAL', 'FAIL',
        `Run summary written with version ${WORKER_VERSION}`,
        'No run_summaries row found in last 30 minutes');
    }

    if (row.worker_version !== WORKER_VERSION) {
      return makeCheck('run_completion', 'CRITICAL', 'FAIL',
        `worker_version = ${WORKER_VERSION}`,
        `worker_version = ${row.worker_version}`,
        'Version mismatch - stale deploy?');
    }

    return makeCheck('run_completion', 'CRITICAL', 'PASS',
      `Run summary written with version ${WORKER_VERSION}`,
      `Found: version=${row.worker_version}, campaigns=${row.campaigns_evaluated}`);
  } catch (err) {
    return makeCheck('run_completion', 'CRITICAL', 'FAIL',
      'Run summary readable', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 2: kill_integrity
// ---------------------------------------------------------------------------

async function checkKillIntegrity(sb: SupabaseClient): Promise<AuditCheckResult> {
  try {
    const { data: kills, error: killsError } = await sb.from('cc_audit_logs')
      .select('campaign, step, variant, campaign_id')
      .eq('action', 'DISABLED')
      .eq('worker_version', WORKER_VERSION)
      .gt('timestamp', thirtyMinAgo());

    if (killsError) {
      return makeCheck('kill_integrity', 'CRITICAL', 'SKIP',
        'Every kill has a dashboard_items entry',
        `Supabase query error on audit_logs: ${killsError.message}`);
    }

    if (!kills || kills.length === 0) {
      return makeCheck('kill_integrity', 'CRITICAL', 'SKIP',
        'Every kill has a dashboard_items entry', 'No DISABLED actions this run');
    }

    const missing: string[] = [];
    let queryErrors = 0;
    for (const kill of kills) {
      const { data: dashItems, error: dashError } = await sb.from('cc_dashboard_items')
        .select('id')
        .eq('campaign_id', kill.campaign_id)
        .eq('step', kill.step)
        .eq('variant', kill.variant)
        .eq('item_type', 'DISABLED')
        .is('resolved_at', null)
        .limit(1);

      if (dashError) {
        queryErrors++;
        continue;
      }

      if (!dashItems || dashItems.length === 0) {
        missing.push(`${kill.campaign} step ${kill.step} var ${kill.variant}`);
      }
    }

    // If ALL dashboard_items lookups errored, skip rather than false-positive
    if (queryErrors > 0 && queryErrors === kills.length) {
      return makeCheck('kill_integrity', 'CRITICAL', 'SKIP',
        'Every kill has a dashboard_items entry',
        `All ${queryErrors} dashboard_items lookups failed - Supabase query errors`);
    }

    const errorNote = queryErrors > 0 ? ` (${queryErrors} lookup errors skipped)` : '';

    if (missing.length > 0) {
      return makeCheck('kill_integrity', 'CRITICAL', 'FAIL',
        `${kills.length} kills all in dashboard_items`,
        `${missing.length} kills missing from dashboard_items${errorNote}`,
        missing.join('; '));
    }

    return makeCheck('kill_integrity', 'CRITICAL', 'PASS',
      `${kills.length} kills all in dashboard_items`,
      `${kills.length - queryErrors}/${kills.length} verified${errorNote}`);
  } catch (err) {
    return makeCheck('kill_integrity', 'CRITICAL', 'FAIL',
      'Kill integrity check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 3: dashboard_dedup
// ---------------------------------------------------------------------------

async function checkDashboardDedup(sb: SupabaseClient): Promise<AuditCheckResult> {
  try {
    const { data } = await sb.from('cc_dashboard_items')
      .select('cm, campaign_id, item_type, step, variant')
      .is('resolved_at', null);

    const seen = new Map<string, number>();
    for (const row of data ?? []) {
      const key = `${row.cm}:${row.campaign_id}:${row.item_type}:${row.step}:${row.variant}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, count]) => count > 1);

    if (dupes.length > 0) {
      const detail = dupes.map(([key, count]) => `${key} (x${count})`).join('; ');
      return makeCheck('dashboard_dedup', 'CRITICAL', 'FAIL',
        'Zero duplicate active dashboard items',
        `${dupes.length} duplicate groups found`,
        detail);
    }

    return makeCheck('dashboard_dedup', 'CRITICAL', 'PASS',
      'Zero duplicate active dashboard items',
      `${seen.size} active items, no duplicates`);
  } catch (err) {
    return makeCheck('dashboard_dedup', 'CRITICAL', 'FAIL',
      'Dashboard dedup check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 4: error_regression
// ---------------------------------------------------------------------------

function checkErrorRegression(runSummary: RunSummary, trailingAvg: TrailingAvg | null): AuditCheckResult {
  const errors = runSummary.errors;
  const avgErrors = trailingAvg?.errors ?? 0;
  const ceiling = Math.max(avgErrors * 2, 3);

  if (errors > 10) {
    return makeCheck('error_regression', 'WARNING', 'FAIL',
      `errors <= 10 (hard ceiling)`,
      `${errors} errors`,
      `Errors: ${errors} this run vs ${avgErrors.toFixed(1)} trailing avg (${trailingAvg?.run_count ?? 0} runs)`);
  }

  if (errors > ceiling) {
    return makeCheck('error_regression', 'WARNING', 'WARN',
      `errors <= ${ceiling.toFixed(0)} (2x trailing avg or floor of 3)`,
      `${errors} errors`,
      `Errors: ${errors} this run vs ${avgErrors.toFixed(1)} trailing avg (${trailingAvg?.run_count ?? 0} runs)`);
  }

  return makeCheck('error_regression', 'WARNING', 'PASS',
    `errors <= ${ceiling.toFixed(0)}`,
    `${errors} errors`);
}

// ---------------------------------------------------------------------------
// Check 5: ghost_audit
// ---------------------------------------------------------------------------

async function checkGhostAudit(kv: KVNamespace, runSummary: RunSummary): Promise<AuditCheckResult> {
  try {
    if (runSummary.ghostReEnables === 0) {
      return makeCheck('ghost_audit', 'WARNING', 'PASS',
        '0 ghost re-enables', '0 ghosts detected');
    }

    if (!runSummary.ghostDetails) {
      return makeCheck('ghost_audit', 'WARNING', 'FAIL',
        'Ghost details captured when ghosts > 0',
        `${runSummary.ghostReEnables} ghosts but ghostDetails is null`,
        'Ghost data missing - silent write failure?');
    }

    // Verify exempt KV keys exist for each ghost
    // ghost.step is 1-based (for display), but exempt KV keys use 0-based stepIndex.
    // Convert back to 0-based by subtracting 1. See index.ts line ~2316.
    const missingExemptKeys: string[] = [];
    for (const ghost of runSummary.ghostDetails) {
      const exemptKey = `exempt:${ghost.campaignId}:${ghost.step - 1}:${ghost.variant}`;
      const val = await kv.get(exemptKey);
      if (!val) missingExemptKeys.push(exemptKey);
    }

    if (missingExemptKeys.length > 0) {
      return makeCheck('ghost_audit', 'WARNING', 'FAIL',
        'All ghosts have exempt KV keys',
        `${missingExemptKeys.length} missing exempt keys`,
        missingExemptKeys.join('; '));
    }

    const ghostList = runSummary.ghostDetails.map(g =>
      `${g.campaign} step ${g.step} var ${g.variant}`).join('; ');
    return makeCheck('ghost_audit', 'WARNING', 'WARN',
      '0 ghost re-enables',
      `${runSummary.ghostReEnables} ghosts detected`,
      ghostList);
  } catch (err) {
    return makeCheck('ghost_audit', 'WARNING', 'FAIL',
      'Ghost audit check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 6: threshold_math
// ---------------------------------------------------------------------------

async function checkThresholdMath(sb: SupabaseClient): Promise<AuditCheckResult> {
  try {
    const { data } = await sb.from('cc_audit_logs')
      .select('campaign, trigger_sent, trigger_opportunities, trigger_ratio, trigger_threshold')
      .in('action', ['DISABLED', 'BLOCKED'])
      .eq('worker_version', WORKER_VERSION)
      .gt('timestamp', thirtyMinAgo())
      .limit(5);

    if (!data || data.length === 0) {
      return makeCheck('threshold_math', 'CRITICAL', 'SKIP',
        'Threshold math internally consistent', 'No DISABLED/BLOCKED entries this run');
    }

    const mismatches: string[] = [];
    for (const row of data) {
      const sent = row.trigger_sent as number;
      const opps = row.trigger_opportunities as number;
      const storedRatio = parseFloat(row.trigger_ratio as string);
      const threshold = row.trigger_threshold as number;

      // If opps > 0, ratio = sent/opps. Verify this matches trigger_ratio.
      if (opps > 0) {
        const expectedRatio = sent / opps;
        const tolerance = expectedRatio * 0.01; // 1% tolerance
        if (Math.abs(storedRatio - expectedRatio) > tolerance) {
          mismatches.push(`${row.campaign}: ratio ${storedRatio} != sent/opps ${expectedRatio.toFixed(1)}`);
        }
      }

      // Verify sent > threshold (it should be, since it was killed/blocked)
      if (sent < threshold && opps === 0) {
        mismatches.push(`${row.campaign}: sent ${sent} < threshold ${threshold}`);
      }
    }

    if (mismatches.length > 0) {
      return makeCheck('threshold_math', 'CRITICAL', 'FAIL',
        'All threshold math internally consistent',
        `${mismatches.length} mismatches in ${data.length} sampled`,
        mismatches.join('; '));
    }

    return makeCheck('threshold_math', 'CRITICAL', 'PASS',
      'All threshold math internally consistent',
      `${data.length} entries verified`);
  } catch (err) {
    return makeCheck('threshold_math', 'CRITICAL', 'FAIL',
      'Threshold math check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 7: kv_integrity
// ---------------------------------------------------------------------------

async function countKvPrefix(kv: KVNamespace, prefix: string): Promise<number> {
  const list = await kv.list({ prefix, limit: 1000 });
  return list.keys.length;
}

async function checkKvIntegrity(kv: KVNamespace, kvSummary: KvSummary): Promise<AuditCheckResult> {
  try {
    // Check for stale rescan keys (older than 48 hours)
    const staleKeys: string[] = [];
    const rescanList = await kv.list({ prefix: 'rescan:', limit: 1000 });
    for (const key of rescanList.keys) {
      const val = await kv.get(key.name);
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (parsed.disabledAt) {
            const age = Date.now() - new Date(parsed.disabledAt).getTime();
            if (age > RESCAN_MAX_WINDOW_HOURS * 60 * 60 * 1000) {
              staleKeys.push(key.name);
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (staleKeys.length > 0) {
      return makeCheck('kv_integrity', 'WARNING', 'WARN',
        'No stale rescan keys (>48h)',
        `${staleKeys.length} stale rescan keys`,
        staleKeys.slice(0, 5).join('; '));
    }

    const total = kvSummary.rescan_keys + kvSummary.exempt_keys +
      kvSummary.ghost_notified_keys + kvSummary.kill_keys + kvSummary.winner_notified_keys;
    return makeCheck('kv_integrity', 'WARNING', 'PASS',
      'KV keys healthy, no stale rescans',
      `${total} total keys (rescan:${kvSummary.rescan_keys} exempt:${kvSummary.exempt_keys} ghost:${kvSummary.ghost_notified_keys} kill:${kvSummary.kill_keys} winner:${kvSummary.winner_notified_keys})`);
  } catch (err) {
    return makeCheck('kv_integrity', 'WARNING', 'FAIL',
      'KV integrity check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 8: supabase_sync
// ---------------------------------------------------------------------------

async function checkSupabaseSync(sb: SupabaseClient, runSummary: RunSummary): Promise<AuditCheckResult> {
  try {
    const failures: string[] = [];
    const cutoff = thirtyMinAgo();

    // If run had kills, verify DISABLED rows exist
    if (runSummary.variantsDisabled > 0) {
      const { count } = await sb.from('cc_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('action', 'DISABLED')
        .eq('worker_version', WORKER_VERSION)
        .gt('timestamp', cutoff);
      if ((count ?? 0) === 0) failures.push('variants_disabled > 0 but no DISABLED audit_logs');
    }

    // If run had blocks, verify BLOCKED rows exist
    if (runSummary.variantsBlocked > 0) {
      const { count } = await sb.from('cc_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('action', 'BLOCKED')
        .eq('worker_version', WORKER_VERSION)
        .gt('timestamp', cutoff);
      if ((count ?? 0) === 0) failures.push('variants_blocked > 0 but no BLOCKED audit_logs');
    }

    // daily_snapshots for today
    const todayDate = new Date().toISOString().slice(0, 10);
    const { count: snapCount } = await sb.from('cc_daily_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('date', todayDate);
    if ((snapCount ?? 0) === 0) failures.push('No daily_snapshot for today');

    if (failures.length > 0) {
      return makeCheck('supabase_sync', 'CRITICAL', 'FAIL',
        'All Supabase tables in sync with run data',
        `${failures.length} sync failures`,
        failures.join('; '));
    }

    return makeCheck('supabase_sync', 'CRITICAL', 'PASS',
      'All Supabase tables in sync with run data',
      'Cross-references match');
  } catch (err) {
    return makeCheck('supabase_sync', 'CRITICAL', 'FAIL',
      'Supabase sync check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 9: slack_delivery
// ---------------------------------------------------------------------------

async function checkSlackDelivery(sb: SupabaseClient): Promise<AuditCheckResult> {
  if (SLACK_SUPPRESSED) {
    return makeCheck('slack_delivery', 'WARNING', 'PASS',
      'All Slack notifications delivered',
      'Slack suppressed - per-item notifications intentionally skipped');
  }

  try {
    const { data } = await sb.from('cc_notifications')
      .select('notification_type, reply_success')
      .eq('worker_version', WORKER_VERSION)
      .gt('timestamp', thirtyMinAgo())
      .eq('reply_success', false);

    const failedCount = data?.length ?? 0;

    if (failedCount > 0) {
      return makeCheck('slack_delivery', 'WARNING', 'WARN',
        'All Slack notifications delivered',
        `${failedCount} failed notifications`,
        null);
    }

    return makeCheck('slack_delivery', 'WARNING', 'PASS',
      'All Slack notifications delivered',
      'No failed deliveries');
  } catch (err) {
    return makeCheck('slack_delivery', 'WARNING', 'FAIL',
      'Slack delivery check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 10: leads_monitoring
// ---------------------------------------------------------------------------

function checkLeadsMonitoring(runSummary: RunSummary): AuditCheckResult {
  if (runSummary.leadsChecked === 0 && runSummary.campaignsEvaluated > 0) {
    return makeCheck('leads_monitoring', 'WARNING', 'FAIL',
      'Leads monitoring ran',
      'leadsChecked = 0 despite campaigns being evaluated',
      'Leads monitoring did not run at all');
  }

  if (runSummary.leadsCheckErrors > 0) {
    return makeCheck('leads_monitoring', 'WARNING', 'WARN',
      'Zero leads check errors',
      `${runSummary.leadsCheckErrors} errors out of ${runSummary.leadsChecked} checked`,
      null);
  }

  return makeCheck('leads_monitoring', 'WARNING', 'PASS',
    'Leads monitoring healthy',
    `${runSummary.leadsChecked} checked, 0 errors`);
}

// ---------------------------------------------------------------------------
// Check 11: winner_detection
// ---------------------------------------------------------------------------

async function checkWinnerDetection(sb: SupabaseClient): Promise<AuditCheckResult> {
  try {
    const { data } = await sb.from('cc_audit_logs')
      .select('campaign, variant_label, trigger_opportunities')
      .eq('action', 'WINNER_DETECTED')
      .eq('worker_version', WORKER_VERSION)
      .gt('timestamp', thirtyMinAgo());

    const badWinners = (data ?? []).filter(w => (w.trigger_opportunities as number) < WINNER_MIN_OPPS);

    if (badWinners.length > 0) {
      const detail = badWinners.map(w =>
        `${w.campaign} ${w.variant_label}: ${w.trigger_opportunities} opps < ${WINNER_MIN_OPPS}`).join('; ');
      return makeCheck('winner_detection', 'INFO', 'FAIL',
        `All winners have >= ${WINNER_MIN_OPPS} opportunities`,
        `${badWinners.length} winners below min opps`,
        detail);
    }

    return makeCheck('winner_detection', 'INFO', 'PASS',
      `All winners have >= ${WINNER_MIN_OPPS} opportunities`,
      `${(data ?? []).length} winners verified`);
  } catch (err) {
    return makeCheck('winner_detection', 'INFO', 'FAIL',
      'Winner detection check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Check 12: cross_run_consistency
// ---------------------------------------------------------------------------

function checkCrossRunConsistency(runSummary: RunSummary, trailingAvg: TrailingAvg | null): AuditCheckResult {
  if (!trailingAvg || trailingAvg.config_changed) {
    return makeCheck('cross_run_consistency', 'WARNING', 'SKIP',
      'Stable numbers vs trailing avg', 'Config changed or no baseline', null);
  }

  const warnings: string[] = [];

  const campaignDelta = Math.abs(runSummary.campaignsEvaluated - trailingAvg.campaigns_evaluated)
    / Math.max(trailingAvg.campaigns_evaluated, 1);
  if (campaignDelta > 0.3) {
    warnings.push(`campaigns: ${runSummary.campaignsEvaluated} vs avg ${trailingAvg.campaigns_evaluated.toFixed(0)} (${(campaignDelta * 100).toFixed(0)}% delta)`);
  }

  // Workspaces: allow tolerance of 1 because listWorkspaces() filters out
  // workspaces without API keys (e.g. one workspace has no key configured).
  const wsDelta = WORKSPACE_CONFIGS.length - runSummary.workspacesProcessed;
  if (wsDelta > 1) {
    warnings.push(`workspaces: ${runSummary.workspacesProcessed} vs config ${WORKSPACE_CONFIGS.length} (${wsDelta} missing)`);
  }

  // Variants disabled: flag if > 3x trailing avg
  if (trailingAvg.variants_disabled > 0 && runSummary.variantsDisabled > trailingAvg.variants_disabled * 3) {
    warnings.push(`kills: ${runSummary.variantsDisabled} vs avg ${trailingAvg.variants_disabled.toFixed(1)} (>3x)`);
  }

  if (warnings.length > 0) {
    return makeCheck('cross_run_consistency', 'WARNING', 'WARN',
      'Key numbers within expected range',
      `${warnings.length} deviations detected`,
      warnings.join('; '));
  }

  return makeCheck('cross_run_consistency', 'WARNING', 'PASS',
    'Key numbers within expected range',
    'All metrics within baseline');
}

// ---------------------------------------------------------------------------
// Check 13: daily_snapshot
// ---------------------------------------------------------------------------

async function checkDailySnapshot(sb: SupabaseClient): Promise<AuditCheckResult> {
  try {
    const todayDate = new Date().toISOString().slice(0, 10);
    const { data } = await sb.from('cc_daily_snapshots')
      .select('date, total_campaigns, total_variants')
      .eq('date', todayDate)
      .limit(1);

    const row = data?.[0];
    if (!row) {
      return makeCheck('daily_snapshot', 'INFO', 'FAIL',
        'Daily snapshot exists for today',
        `No snapshot for ${todayDate}`);
    }

    if ((row.total_campaigns as number) === 0) {
      return makeCheck('daily_snapshot', 'INFO', 'FAIL',
        'Daily snapshot has data',
        `Snapshot exists but total_campaigns = 0`);
    }

    return makeCheck('daily_snapshot', 'INFO', 'PASS',
      'Daily snapshot exists for today',
      `${row.total_campaigns} campaigns, ${row.total_variants} variants`);
  } catch (err) {
    return makeCheck('daily_snapshot', 'INFO', 'FAIL',
      'Daily snapshot check', `Error: ${err}`, null);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function computeVerdict(checks: AuditCheckResult[]): AuditVerdict {
  const hasCriticalFail = checks.some(c => c.severity === 'CRITICAL' && c.status === 'FAIL');
  if (hasCriticalFail) return 'RED';

  const hasWarningIssue = checks.some(c =>
    c.severity === 'WARNING' && (c.status === 'FAIL' || c.status === 'WARN'),
  );
  if (hasWarningIssue) return 'YELLOW';

  return 'GREEN';
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

function buildAuditResult(
  runSummary: RunSummary,
  checks: AuditCheckResult[],
  verdict: AuditVerdict,
  configSnapshot: AuditConfigSnapshot,
  kvSummary: KvSummary | null,
  trailingAvg: TrailingAvg | null,
  priorRun: Record<string, unknown> | null,
  auditStart: number,
): AuditResult {
  return {
    run_timestamp: runSummary.timestamp,
    worker_version: WORKER_VERSION,
    verdict,
    checks_total: checks.length,
    checks_passed: checks.filter(c => c.status === 'PASS').length,
    checks_failed: checks.filter(c => c.status === 'FAIL').length,
    checks_warned: checks.filter(c => c.status === 'WARN').length,
    checks_skipped: checks.filter(c => c.status === 'SKIP').length,
    kills: runSummary.variantsDisabled,
    blocks: runSummary.variantsBlocked,
    winners: runSummary.winnersDetected,
    errors: runSummary.errors,
    ghosts: runSummary.ghostReEnables,
    campaigns_evaluated: runSummary.campaignsEvaluated,
    workspaces_processed: runSummary.workspacesProcessed,
    duration_ms: runSummary.durationMs,
    delta_kills: priorRun ? runSummary.variantsDisabled - (priorRun.variants_disabled as number ?? 0) : null,
    delta_blocks: priorRun ? runSummary.variantsBlocked - (priorRun.variants_blocked as number ?? 0) : null,
    delta_winners: priorRun ? runSummary.winnersDetected - (priorRun.winners_detected as number ?? 0) : null,
    delta_errors: priorRun ? runSummary.errors - (priorRun.errors as number ?? 0) : null,
    delta_campaigns: priorRun ? runSummary.campaignsEvaluated - (priorRun.campaigns_evaluated as number ?? 0) : null,
    check_results: checks,
    config_snapshot: configSnapshot,
    kv_summary: kvSummary,
    trailing_avg: trailingAvg,
    audit_duration_ms: Date.now() - auditStart,
  };
}

// ---------------------------------------------------------------------------
// Config snapshot
// ---------------------------------------------------------------------------

function buildConfigSnapshot(): AuditConfigSnapshot {
  return {
    pilot_cms: Array.from(PILOT_CMS),
    dry_run_cms: Array.from(DRY_RUN_CMS),
    workspace_count: WORKSPACE_CONFIGS.length,
    max_kills_per_run: MAX_KILLS_PER_RUN,
    kills_enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Trailing data
// ---------------------------------------------------------------------------

async function fetchTrailingRuns(sb: SupabaseClient, currentTimestamp: string): Promise<Record<string, unknown>[]> {
  const { data } = await sb.from('cc_run_summaries')
    .select('campaigns_evaluated, variants_disabled, variants_blocked, errors, workspaces_processed, leads_checked, leads_check_errors, winners_detected, ghost_re_enables')
    .lt('created_at', currentTimestamp)
    .not('worker_version', 'is', null)
    .order('created_at', { ascending: false })
    .limit(3);
  return (data ?? []) as Record<string, unknown>[];
}

async function fetchPriorAudit(sb: SupabaseClient): Promise<{ config_snapshot: AuditConfigSnapshot } | null> {
  const { data } = await sb.from('audit_results')
    .select('config_snapshot')
    .order('created_at', { ascending: false })
    .limit(1);
  return (data?.[0] as { config_snapshot: AuditConfigSnapshot } | undefined) ?? null;
}

function computeTrailingAvg(
  trailingRuns: Record<string, unknown>[],
  currentConfig: AuditConfigSnapshot,
  priorAudit: { config_snapshot: AuditConfigSnapshot } | null,
): TrailingAvg | null {
  if (trailingRuns.length === 0) return null;

  const avg = (field: string) =>
    trailingRuns.reduce((sum, r) => sum + ((r[field] as number) ?? 0), 0) / trailingRuns.length;

  const configChanged = priorAudit
    ? priorAudit.config_snapshot.pilot_cms.length !== currentConfig.pilot_cms.length
      || priorAudit.config_snapshot.workspace_count !== currentConfig.workspace_count
    : false;

  return {
    campaigns_evaluated: avg('campaigns_evaluated'),
    variants_disabled: avg('variants_disabled'),
    variants_blocked: avg('variants_blocked'),
    errors: avg('errors'),
    run_count: trailingRuns.length,
    config_changed: configChanged,
  };
}

// ---------------------------------------------------------------------------
// KV summary
// ---------------------------------------------------------------------------

async function buildKvSummary(kv: KVNamespace): Promise<KvSummary> {
  return {
    rescan_keys: await countKvPrefix(kv, 'rescan:'),
    exempt_keys: await countKvPrefix(kv, 'exempt:'),
    ghost_notified_keys: await countKvPrefix(kv, 'ghost-notified:'),
    kill_keys: await countKvPrefix(kv, 'kill:'),
    winner_notified_keys: await countKvPrefix(kv, 'winner-notified:'),
    step_frozen_keys: await countKvPrefix(kv, 'step-frozen:'),
  };
}

// ---------------------------------------------------------------------------
// Supabase write
// ---------------------------------------------------------------------------

async function writeAuditResult(sb: SupabaseClient, result: AuditResult): Promise<void> {
  const payload = {
    run_timestamp: result.run_timestamp,
    worker_version: result.worker_version,
    verdict: result.verdict,
    checks_total: result.checks_total,
    checks_passed: result.checks_passed,
    checks_failed: result.checks_failed,
    checks_warned: result.checks_warned,
    checks_skipped: result.checks_skipped,
    kills: result.kills,
    blocks: result.blocks,
    winners: result.winners,
    errors: result.errors,
    ghosts: result.ghosts,
    campaigns_evaluated: result.campaigns_evaluated,
    workspaces_processed: result.workspaces_processed,
    duration_ms: result.duration_ms,
    delta_kills: result.delta_kills,
    delta_blocks: result.delta_blocks,
    delta_winners: result.delta_winners,
    delta_errors: result.delta_errors,
    delta_campaigns: result.delta_campaigns,
    check_results: result.check_results,
    config_snapshot: result.config_snapshot,
    kv_summary: result.kv_summary,
    trailing_avg: result.trailing_avg,
    audit_duration_ms: result.audit_duration_ms,
  };

  const { error } = await sb.from('audit_results').insert(payload);
  if (!error) return;

  console.error(`[self-audit] audit_results insert failed (attempt 1): ${error.message}`);

  // Single retry after 1.5s delay
  await new Promise((r) => setTimeout(r, 1500));
  const { error: retryError } = await sb.from('audit_results').insert(payload);
  if (retryError) {
    console.error(`[self-audit] audit_results insert failed (attempt 2): ${retryError.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupOldAuditResults(sb: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const { error } = await sb.from('audit_results').delete().lt('created_at', cutoff);
  if (error) console.error(`[self-audit] cleanup failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Slack digest
// ---------------------------------------------------------------------------

function formatAuditDigest(result: AuditResult, dashboardUrl: string): string {
  const time = new Date(result.run_timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
  });

  const yellowCount = result.check_results.filter(c =>
    c.severity === 'WARNING' && (c.status === 'FAIL' || c.status === 'WARN')).length;
  const verdictText = result.verdict === 'GREEN' ? 'All Clear'
    : result.verdict === 'YELLOW' ? `${yellowCount} Warning${yellowCount !== 1 ? 's' : ''}`
    : 'FAILED';

  const emoji = result.verdict === 'GREEN' ? ':large_green_circle:'
    : result.verdict === 'YELLOW' ? ':large_yellow_circle:'
    : ':red_circle:';

  let msg = `${emoji} CC Audit: ${time} ET (${result.worker_version}) - ${verdictText}\n\n`;
  msg += `${result.checks_passed}/${result.checks_total} checks passed\n`;
  msg += `Kills: ${result.kills} | Blocks: ${result.blocks} | Winners: ${result.winners} | Errors: ${result.errors}`;

  // Deltas
  const deltas: string[] = [];
  if (result.delta_kills !== null && result.delta_kills !== 0) deltas.push(`kills ${result.delta_kills > 0 ? '+' : ''}${result.delta_kills}`);
  if (result.delta_blocks !== null && result.delta_blocks !== 0) deltas.push(`blocks ${result.delta_blocks > 0 ? '+' : ''}${result.delta_blocks}`);
  if (result.delta_errors !== null && result.delta_errors !== 0) deltas.push(`errors ${result.delta_errors > 0 ? '+' : ''}${result.delta_errors}`);
  if (deltas.length > 0) msg += `\nvs prior: ${deltas.join(', ')}`;

  // Failed/warned checks
  const issues = result.check_results.filter(c => c.status === 'FAIL' || c.status === 'WARN');
  if (issues.length > 0) {
    msg += '\n';
    for (const issue of issues) {
      const icon = issue.status === 'FAIL' ? '[X]' : '[!]';
      msg += `\n${icon} ${issue.name}: ${issue.actual}`;
    }
  }

  msg += `\n\nDashboard: ${dashboardUrl}/admin`;
  return msg;
}

async function postAuditDigest(
  slackToken: string,
  channel: string,
  result: AuditResult,
  dashboardUrl: string,
): Promise<void> {
  const text = formatAuditDigest(result, dashboardUrl);
  const payload = {
    channel,
    text,
    username: 'Campaign Control',
    icon_emoji: ':control_knobs:',
  };

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[self-audit] Slack API error: ${res.status} ${await res.text()}`);
    } else {
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) console.error(`[self-audit] Slack post failed: ${data.error}`);
    }
  } catch (err) {
    console.error(`[self-audit] Slack digest error: ${err}`);
  }
}
