import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry, LeadsAuditEntry, RunSummary, DailySnapshot, DashboardItemType } from './types';
import { WORKER_VERSION } from './version';

let client: SupabaseClient | null = null;

export function getSupabaseClient(url: string, key: string): SupabaseClient {
  if (!client) {
    client = createClient(url, key);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Fire-and-forget write helpers
// ---------------------------------------------------------------------------

export async function writeAuditLogToSupabase(
  sb: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await sb.from('audit_logs').insert({
    timestamp: entry.timestamp,
    action: entry.action,
    workspace: entry.workspace,
    workspace_id: entry.workspaceId,
    campaign: entry.campaign,
    campaign_id: entry.campaignId,
    step: entry.step,
    variant: entry.variant,
    variant_label: entry.variantLabel,
    cm: entry.cm,
    product: entry.product,
    trigger_sent: entry.trigger.sent,
    trigger_opportunities: entry.trigger.opportunities,
    trigger_ratio: entry.trigger.ratio,
    trigger_threshold: entry.trigger.threshold,
    trigger_rule: entry.trigger.rule,
    safety_surviving_variants: entry.safety.survivingVariants,
    safety_notification: entry.safety.notification,
    dry_run: entry.dryRun,
    worker_version: WORKER_VERSION,
  });
  if (error) console.error(`[supabase] audit_logs insert failed: ${error.message}`);
}

export async function writeLeadsAuditToSupabase(
  sb: SupabaseClient,
  entry: LeadsAuditEntry,
): Promise<void> {
  const { error } = await sb.from('leads_audit_logs').insert({
    timestamp: entry.timestamp,
    action: entry.action,
    workspace: entry.workspace,
    workspace_id: entry.workspaceId,
    campaign: entry.campaign,
    campaign_id: entry.campaignId,
    cm: entry.cm,
    leads_total: entry.leads.total,
    leads_contacted: entry.leads.contacted,
    leads_active_in_sequence: entry.leads.active_in_sequence,
    leads_completed: entry.leads.completed,
    leads_active: entry.leads.active,
    leads_bounced: entry.leads.bounced,
    leads_skipped: entry.leads.skipped,
    leads_unsubscribed: entry.leads.unsubscribed,
    leads_daily_limit: entry.leads.dailyLimit,
    dry_run: entry.dryRun,
    worker_version: WORKER_VERSION,
  });
  if (error) console.error(`[supabase] leads_audit_logs insert failed: ${error.message}`);
}

/**
 * Insert a run_summary row. Returns the row UUID so it can be updated later
 * (e.g. after subsequent phases complete). Returns null on failure.
 */
export async function writeRunSummaryToSupabase(
  sb: SupabaseClient,
  summary: RunSummary,
): Promise<string | null> {
  const { data, error } = await sb.from('run_summaries').insert({
    timestamp: summary.timestamp,
    workspaces_processed: summary.workspacesProcessed,
    campaigns_evaluated: summary.campaignsEvaluated,
    variants_disabled: summary.variantsDisabled,
    variants_blocked: summary.variantsBlocked,
    variants_kills_paused: summary.variantsKillsPaused,
    variants_warned: summary.variantsWarned,
    errors: summary.errors,
    duration_ms: summary.durationMs,
    rescan_checked: summary.rescanChecked,
    rescan_re_enabled: summary.rescanReEnabled,
    rescan_expired: summary.rescanExpired,
    rescan_cm_override: summary.rescanCmOverride,
    leads_checked: summary.leadsChecked,
    leads_check_errors: summary.leadsCheckErrors,
    leads_warnings: summary.leadsWarnings,
    leads_exhausted: summary.leadsExhausted,
    leads_recovered: summary.leadsRecovered,
    ghost_re_enables: summary.ghostReEnables,
    ghost_details: summary.ghostDetails ?? null,
    winners_detected: summary.winnersDetected,
    warm_leads_skipped: summary.warmLeadsSkipped,
    steps_frozen: summary.stepsFrozen,
    freeze_re_enables: summary.freezeReEnables,
    dry_run: summary.dryRun,
    worker_version: WORKER_VERSION,
  }).select('id').single();
  if (error) {
    console.error(`[supabase] run_summaries insert failed: ${error.message}`);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Update an existing run_summary row by ID with final data from later phases.
 * Used to upgrade the early/partial summary written after Phase 1 with
 * rescan, leads, ghost, and duration data from Phases 2-7.
 */
export async function updateRunSummaryInSupabase(
  sb: SupabaseClient,
  rowId: string,
  summary: RunSummary,
): Promise<void> {
  const { error } = await sb.from('run_summaries').update({
    timestamp: summary.timestamp,
    workspaces_processed: summary.workspacesProcessed,
    campaigns_evaluated: summary.campaignsEvaluated,
    variants_disabled: summary.variantsDisabled,
    variants_blocked: summary.variantsBlocked,
    variants_kills_paused: summary.variantsKillsPaused,
    variants_warned: summary.variantsWarned,
    errors: summary.errors,
    duration_ms: summary.durationMs,
    rescan_checked: summary.rescanChecked,
    rescan_re_enabled: summary.rescanReEnabled,
    rescan_expired: summary.rescanExpired,
    rescan_cm_override: summary.rescanCmOverride,
    leads_checked: summary.leadsChecked,
    leads_check_errors: summary.leadsCheckErrors,
    leads_warnings: summary.leadsWarnings,
    leads_exhausted: summary.leadsExhausted,
    leads_recovered: summary.leadsRecovered,
    ghost_re_enables: summary.ghostReEnables,
    ghost_details: summary.ghostDetails ?? null,
    winners_detected: summary.winnersDetected,
    warm_leads_skipped: summary.warmLeadsSkipped,
    steps_frozen: summary.stepsFrozen,
    freeze_re_enables: summary.freezeReEnables,
    dry_run: summary.dryRun,
    worker_version: WORKER_VERSION,
  }).eq('id', rowId);
  if (error) console.error(`[supabase] run_summaries update failed: ${error.message}`);
}

export async function writeDailySnapshotToSupabase(
  sb: SupabaseClient,
  snapshot: DailySnapshot,
): Promise<void> {
  const row = {
    date: snapshot.date,
    captured_at: snapshot.capturedAt,
    total_campaigns: snapshot.totalCampaigns,
    total_steps: snapshot.totalSteps,
    total_variants: snapshot.totalVariants,
    active_variants: snapshot.activeVariants,
    disabled_variants: snapshot.disabledVariants,
    above_threshold: snapshot.aboveThreshold,
    actions_disabled: snapshot.actionsToday.disabled,
    actions_blocked: snapshot.actionsToday.blocked,
    actions_warned: snapshot.actionsToday.warned,
    actions_re_enabled: snapshot.actionsToday.reEnabled,
    actions_expired: snapshot.actionsToday.expired,
    actions_cm_override: snapshot.actionsToday.cmOverride,
    by_workspace: snapshot.byWorkspace,
    by_cm: snapshot.byCm,
    campaign_health: snapshot.campaignHealth,
    worker_version: WORKER_VERSION,
  };

  const { error } = await sb.from('daily_snapshots').upsert(row, {
    onConflict: 'date',
  });
  if (error) console.error(`[supabase] daily_snapshots upsert failed: ${error.message}`);
}

export interface NotificationRecord {
  timestamp: string;
  notification_type: string;
  channel_id: string;
  title: string;
  details: string;
  thread_ts: string | null;
  reply_success: boolean | null;
  campaign_id: string | null;
  campaign_name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  cm: string | null;
  step: number | null;
  variant: number | null;
  variant_label: string | null;
  dry_run: boolean;
}

export async function writeNotificationToSupabase(
  sb: SupabaseClient,
  record: NotificationRecord,
): Promise<void> {
  const { error } = await sb.from('notifications').insert({
    ...record,
    worker_version: WORKER_VERSION,
  });
  if (error) console.error(`[supabase] notifications insert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Dashboard state helpers
// ---------------------------------------------------------------------------

export async function upsertDashboardItem(
  sb: SupabaseClient,
  item: {
    item_type: string;
    severity: string;
    cm: string;
    campaign_id: string;
    campaign_name: string;
    workspace_id: string;
    workspace_name: string;
    step: number | null;
    variant: number | null;
    variant_label: string | null;
    context: Record<string, unknown>;
  },
): Promise<void> {
  // Check if an active item already exists for this issue
  // Must filter by step+variant to match the unique index: (cm, campaign_id, item_type, COALESCE(step, -1), COALESCE(variant, -1))
  let query = sb
    .from('dashboard_items')
    .select('id, created_at, dismissed_at')
    .eq('cm', item.cm)
    .eq('campaign_id', item.campaign_id)
    .eq('item_type', item.item_type)
    .is('resolved_at', null);

  if (item.step !== null) {
    query = query.eq('step', item.step);
  } else {
    query = query.is('step', null);
  }

  if (item.variant !== null && item.variant !== undefined) {
    query = query.eq('variant', item.variant);
  } else {
    query = query.is('variant', null);
  }

  const { data: existing } = await query.limit(1);
  const match = existing?.[0];

  if (match) {
    // Items dismissed by CM should stay dismissed while the problem persists.
    // They'll auto-resolve (resolved_at set) when the problem clears,
    // or reappear if the problem recurs after resolution.
    if (match.dismissed_at) return;

    // Update existing: refresh last_scan_at and context
    const { error } = await sb
      .from('dashboard_items')
      .update({
        last_scan_at: new Date().toISOString(),
        context: item.context,
        variant: item.variant,
        variant_label: item.variant_label,
        workspace_name: item.workspace_name,
        campaign_name: item.campaign_name,
        worker_version: WORKER_VERSION,
      })
      .eq('id', match.id);
    if (error) console.error(`[supabase] dashboard_items update failed: ${error.message}`);
  } else {
    // Insert new item
    const { error } = await sb
      .from('dashboard_items')
      .insert({
        ...item,
        created_at: new Date().toISOString(),
        last_scan_at: new Date().toISOString(),
        worker_version: WORKER_VERSION,
      });
    if (error) console.error(`[supabase] dashboard_items insert failed: ${error.message}`);
  }
}

// Item types that represent permanent actions (kills, freezes). These should
// never be auto-resolved because subsequent runs won't re-detect them — the
// variant is already disabled in Instantly. Only explicit CM action (dismiss
// from dashboard) should clear these.
const PERMANENT_ITEM_TYPES: Set<string> = new Set(['DISABLED', 'STEP_FROZEN']);

export async function resolveStaleItems(
  sb: SupabaseClient,
  cm: string,
  activeKeys: Set<string>,
  scanTimestamp: string,
): Promise<number> {
  // Get all active items for this CM
  const { data: activeItems, error: fetchErr } = await sb
    .from('dashboard_items')
    .select('id, item_type, campaign_id, campaign_name, workspace_id, step, variant, created_at')
    .eq('cm', cm)
    .is('resolved_at', null);

  if (fetchErr || !activeItems) {
    console.error(`[supabase] dashboard_items fetch failed: ${fetchErr?.message}`);
    return 0;
  }

  let resolved = 0;
  for (const item of activeItems) {
    // Permanent action items (DISABLED, STEP_FROZEN) are never auto-resolved.
    // Once a variant is killed or a step is frozen, subsequent runs won't
    // re-detect it (it's already disabled in Instantly), so it will never
    // appear in activeKeys. Auto-resolving these would erase the record
    // on the very next run. They should only be resolved by explicit CM
    // action (dismiss from dashboard).
    if (PERMANENT_ITEM_TYPES.has(item.item_type as string)) continue;

    const key = `${item.campaign_id}:${item.item_type}:${item.step ?? 'null'}:${item.variant ?? 'null'}`;
    if (!activeKeys.has(key)) {
      // This item was not found in the current scan - resolve it
      const now = new Date().toISOString();
      const { error: updateErr } = await sb
        .from('dashboard_items')
        .update({ resolved_at: now, worker_version: WORKER_VERSION })
        .eq('id', item.id);
      if (updateErr) {
        console.error(`[supabase] dashboard_items resolve failed: ${updateErr.message}`);
        continue;
      }

      // Write resolution log entry
      const { error: logErr } = await sb
        .from('resolution_log')
        .insert({
          item_type: item.item_type,
          cm,
          campaign_id: item.campaign_id,
          campaign_name: item.campaign_name,
          workspace_id: item.workspace_id,
          step: item.step,
          variant: item.variant,
          created_at: item.created_at,
          resolved_at: now,
          resolution_scan_id: scanTimestamp,
          worker_version: WORKER_VERSION,
          resolution_method: 'auto',
        });
      if (logErr) console.error(`[supabase] resolution_log insert failed: ${logErr.message}`);

      resolved++;
    }
  }
  return resolved;
}

export async function getDashboardDigestData(
  sb: SupabaseClient,
  cm: string,
): Promise<{
  activeCount: number;
  criticalCount: number;
  killsSince: number;
  reEnablesSince: number;
  winnersLast24h: Array<{ campaignName: string; variantLabel: string; ratio: string }>;
}> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Active dashboard items
  const { count: activeCount } = await sb
    .from('dashboard_items')
    .select('*', { count: 'exact', head: true })
    .eq('cm', cm)
    .is('resolved_at', null);

  const { count: criticalCount } = await sb
    .from('dashboard_items')
    .select('*', { count: 'exact', head: true })
    .eq('cm', cm)
    .eq('severity', 'CRITICAL')
    .is('resolved_at', null);

  // Kills since yesterday
  const { count: killsSince } = await sb
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('cm', cm)
    .eq('action', 'DISABLED')
    .gte('timestamp', yesterday)
    .not('worker_version', 'is', null);

  // Re-enables since yesterday
  const { count: reEnablesSince } = await sb
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('cm', cm)
    .eq('action', 'RE_ENABLED')
    .gte('timestamp', yesterday)
    .not('worker_version', 'is', null);

  // Winners detected in last 24h (for digest top performers line)
  const { data: winnerRows } = await sb
    .from('audit_logs')
    .select('campaign, variant_label, trigger_ratio')
    .eq('cm', cm)
    .eq('action', 'WINNER_DETECTED')
    .gte('timestamp', yesterday)
    .not('worker_version', 'is', null)
    .limit(20);

  const winnersLast24h = (winnerRows ?? [])
    .sort((a, b) => parseFloat(a.trigger_ratio as string) - parseFloat(b.trigger_ratio as string))
    .slice(0, 10)
    .map(row => ({
      campaignName: row.campaign as string,
      variantLabel: row.variant_label as string,
      ratio: `${row.trigger_ratio}:1`,
    }));

  return {
    activeCount: activeCount ?? 0,
    criticalCount: criticalCount ?? 0,
    killsSince: killsSince ?? 0,
    reEnablesSince: reEnablesSince ?? 0,
    winnersLast24h,
  };
}
