import { McpClient } from './mcp-client';
import { InstantlyApi } from './instantly';
import { InstantlyDirectApi } from './instantly-direct';
import { evaluateStep, evaluateVariant, checkVariantWarnings } from './evaluator';
import { resolveChannel, resolveCmName, isPilotCampaign, isPilotWorkspace } from './router';
import {
  NotificationCollector,
  formatKillDetails, formatLastVariantDetails,
  formatWarningDetails, formatRescanDetails,
  formatLeadsWarningDetails, formatLeadsExhaustedDetails,
  sendMorningDigest,
} from './slack';
import type { NotificationMeta } from './slack';
import {
  getSupabaseClient, writeAuditLogToSupabase, writeLeadsAuditToSupabase,
  writeRunSummaryToSupabase, writeDailySnapshotToSupabase, writeNotificationToSupabase,
  getDashboardDigestData,
} from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  WORKSPACE_CONFIGS,
  getWorkspaceConfig,
  VARIANT_LABELS,
  WARNING_DEDUP_TTL_SECONDS,
  KILL_DEDUP_TTL_SECONDS,
  RESCAN_DELAY_HOURS,
  RESCAN_TTL_SECONDS,
  RESCAN_MAX_WINDOW_HOURS,
  MAX_KILLS_PER_RUN,
  LEADS_WARNING_DEDUP_TTL_SECONDS,
  LEADS_EXHAUSTED_DEDUP_TTL_SECONDS,
  CM_MONITOR_CHANNELS,
  DASHBOARD_BASE_URL,
  OPP_RUNWAY_MULTIPLIER,
  DRY_RUN_CMS,
  MAX_PERSISTENCE_CHECKS,
} from './config';
import { resolveThreshold } from './thresholds';
import { serveDashboard } from './dashboard';
import { handleRevert } from './revert';
import type {
  Env, KillAction, CampaignDetail, StepAnalytics, AuditEntry, RunSummary, RescanEntry,
  DailySnapshot, BaselineSnapshot, WorkspaceSnapshot, CmSnapshot, CampaignHealthEntry,
  LeadsCheckCandidate, LeadsWarningEntry, LeadsExhaustedEntry, LeadsAuditEntry,
} from './types';

import { evaluateLeadDepletion } from './leads-monitor';
import { buildDashboardState } from './dashboard-state';

// ---------------------------------------------------------------------------
// KV lock helpers
// ---------------------------------------------------------------------------

async function acquireLock(kv: KVNamespace): Promise<boolean> {
  const existing = await kv.get('auto-turnoff-lock');
  if (existing) {
    const lockTime = parseInt(existing, 10);
    if (Date.now() - lockTime < 30 * 60 * 1000) return false;
  }
  await kv.put('auto-turnoff-lock', Date.now().toString());
  return true;
}

async function releaseLock(kv: KVNamespace): Promise<void> {
  await kv.delete('auto-turnoff-lock');
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

async function writeAuditLog(kv: KVNamespace, entry: AuditEntry): Promise<void> {
  const key = `log:${entry.timestamp}:${entry.campaignId}:${entry.step}:${entry.variant}`;
  await kv.put(key, JSON.stringify(entry), { expirationTtl: 90 * 86400 });
}

async function writeRunSummary(kv: KVNamespace, summary: RunSummary): Promise<void> {
  const key = `run:${summary.timestamp}`;
  await kv.put(key, JSON.stringify(summary), { expirationTtl: 90 * 86400 });
}

async function writeRescanEntry(kv: KVNamespace, entry: RescanEntry): Promise<void> {
  const key = `rescan:${entry.campaignId}:${entry.stepIndex}:${entry.variantIndex}`;
  await kv.put(key, JSON.stringify(entry), { expirationTtl: RESCAN_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// OFF campaign filter
// ---------------------------------------------------------------------------

function isOffCampaign(name: string): boolean {
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF[\s\-]/iu.test(name);
}

// ---------------------------------------------------------------------------
// Clear V1 stale KV keys (one-time cleanup before V2 deploy)
// ---------------------------------------------------------------------------

async function clearV1Keys(env: Env): Promise<Response> {
  const prefixes = ['kill:', 'blocked:', 'warning:', 'rescan:'];
  const stats: Record<string, number> = {};
  let totalDeleted = 0;

  for (const prefix of prefixes) {
    let cursor: string | undefined;
    let count = 0;

    do {
      const list = await env.KV.list({ prefix, cursor, limit: 100 });
      for (const key of list.keys) {
        await env.KV.delete(key.name);
        count++;
      }
      cursor = list.list_complete ? undefined : (list.cursor ?? undefined);
    } while (cursor);

    stats[prefix] = count;
    totalDeleted += count;
  }

  return Response.json({
    message: `Cleared ${totalDeleted} V1 KV keys`,
    breakdown: stats,
  });
}

// ---------------------------------------------------------------------------
// Baseline capture
// ---------------------------------------------------------------------------

async function serveBaseline(env: Env, params: URLSearchParams): Promise<Response> {
  const note = params.get('note') ?? 'Pre-go-live baseline';
  const mcp = new McpClient();
  const instantly = new InstantlyApi(mcp);

  try {
    await mcp.connect();

    const allWorkspaces = await instantly.listWorkspaces();
    const configuredIds = new Set(WORKSPACE_CONFIGS.map((c) => c.id));
    const monitoredWorkspaces = allWorkspaces.filter((ws) => configuredIds.has(ws.id));

    const acc = {
      totalCampaigns: 0,
      totalSteps: 0,
      totalVariants: 0,
      activeVariants: 0,
      disabledVariants: 0,
      aboveThreshold: 0,
      byWorkspace: {} as Record<string, WorkspaceSnapshot>,
      byCm: {} as Record<string, CmSnapshot>,
      campaignHealth: [] as CampaignHealthEntry[],
    };

    for (const workspace of monitoredWorkspaces) {
      const wsConfig = getWorkspaceConfig(workspace.id);
      if (!wsConfig) continue;

      const campaigns = await instantly.getCampaigns(workspace.id);
      const activeCampaigns = campaigns;

      if (!acc.byWorkspace[workspace.id]) {
        acc.byWorkspace[workspace.id] = {
          name: workspace.name, product: wsConfig.product,
          totalVariants: 0, activeVariants: 0, disabledVariants: 0, aboveThreshold: 0,
        };
      }

      for (const campaign of activeCampaigns) {
        try {
          const campaignDetail = await instantly.getCampaignDetails(workspace.id, campaign.id);

          if (!campaignDetail.sequences?.length || !campaignDetail.sequences[0]?.steps?.length) continue;

          const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id);

          const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV, isOffCampaign(campaign.name));
          if (threshold === null) continue;

          const cmName = resolveCmName(wsConfig, campaign.name);
          const primaryStepCount = campaignDetail.sequences[0].steps.length;
          const primaryAnalytics = allAnalytics.filter(
            (a) => parseInt(a.step, 10) < primaryStepCount,
          );

          acc.totalCampaigns++;
          let campTotal = 0, campActive = 0, campDisabled = 0, campAbove = 0;

          for (let si = 0; si < primaryStepCount; si++) {
            const stepDetail = campaignDetail.sequences[0].steps[si];
            acc.totalSteps++;

            for (let vi = 0; vi < stepDetail.variants.length; vi++) {
              campTotal++;
              if (stepDetail.variants[vi].v_disabled === true) {
                campDisabled++;
              } else {
                campActive++;
                const row = primaryAnalytics.find(
                  (a) => parseInt(a.step, 10) === si && parseInt(a.variant, 10) === vi,
                );
                if (row) {
                  const decision = evaluateVariant(row.sent, row.opportunities, threshold);
                  if (decision.action === 'KILL_CANDIDATE') {
                    campAbove++;
                  }
                }
              }
            }
          }

          acc.totalVariants += campTotal;
          acc.activeVariants += campActive;
          acc.disabledVariants += campDisabled;
          acc.aboveThreshold += campAbove;

          acc.byWorkspace[workspace.id].totalVariants += campTotal;
          acc.byWorkspace[workspace.id].activeVariants += campActive;
          acc.byWorkspace[workspace.id].disabledVariants += campDisabled;
          acc.byWorkspace[workspace.id].aboveThreshold += campAbove;

          const cmKey = cmName ?? 'UNKNOWN';
          if (!acc.byCm[cmKey]) {
            acc.byCm[cmKey] = { totalVariants: 0, activeVariants: 0, disabledVariants: 0, aboveThreshold: 0 };
          }
          acc.byCm[cmKey].totalVariants += campTotal;
          acc.byCm[cmKey].activeVariants += campActive;
          acc.byCm[cmKey].disabledVariants += campDisabled;
          acc.byCm[cmKey].aboveThreshold += campAbove;

          const healthPct = campTotal > 0 ? ((campActive - campAbove) / campTotal) * 100 : 0;
          acc.campaignHealth.push({
            campaignId: campaign.id,
            campaignName: campaign.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            cm: cmName,
            totalVariants: campTotal,
            activeVariants: campActive,
            disabledVariants: campDisabled,
            aboveThreshold: campAbove,
            healthPct: Math.round(healthPct * 10) / 10,
          });
        } catch (err) {
          console.error(`[baseline] Error processing campaign ${campaign.name}: ${err}`);
        }
      }
    }

    const baseline: BaselineSnapshot = {
      type: 'baseline',
      note,
      date: new Date().toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
      totalCampaigns: acc.totalCampaigns,
      totalSteps: acc.totalSteps,
      totalVariants: acc.totalVariants,
      activeVariants: acc.activeVariants,
      disabledVariants: acc.disabledVariants,
      aboveThreshold: acc.aboveThreshold,
      actionsToday: { disabled: 0, blocked: 0, warned: 0, reEnabled: 0, expired: 0, cmOverride: 0 },
      byWorkspace: acc.byWorkspace,
      byCm: acc.byCm,
      campaignHealth: acc.campaignHealth
        .sort((a, b) => a.healthPct - b.healthPct)
        .slice(0, 100),
    };

    const kvKey = `baseline:${baseline.capturedAt}`;
    await env.KV.put(kvKey, JSON.stringify(baseline));

    console.log(
      `[baseline] Captured: ${baseline.totalVariants} variants, ${baseline.aboveThreshold} above threshold, ${baseline.totalCampaigns} campaigns`,
    );

    return new Response(JSON.stringify(baseline, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    await mcp.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Deploy-safety: skip catch-up runs triggered by deploys.
    // If execution starts >5 min after the scheduled time, it's a stale trigger.
    const delay = Date.now() - event.scheduledTime;
    if (delay > 5 * 60 * 1000) {
      console.log(JSON.stringify({
        event: 'scheduled_skip',
        reason: 'stale_trigger',
        scheduledTime: new Date(event.scheduledTime).toISOString(),
        actualTime: new Date().toISOString(),
        delayMs: delay,
      }));
      return;
    }

    // 12:00 UTC = 8am EDT: morning digest only (no full eval)
    const scheduledHour = new Date(event.scheduledTime).getUTCHours();
    if (scheduledHour === 12) {
      const digestPromise = executeMorningDigest(env);
      ctx.waitUntil(digestPromise);
      await digestPromise;
      return;
    }

    // 10:00, 16:00, 22:00 UTC = 6am, 12pm, 6pm EDT: full evaluation run
    const runPromise = executeScheduledRun(env);
    ctx.waitUntil(runPromise);
    await runPromise;
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__scheduled') {
      const runPromise = executeScheduledRun(env);
      ctx.waitUntil(runPromise);
      await runPromise;
      return new Response('Scheduled run complete. Check console logs for output.');
    }

    if (url.pathname === '/__dashboard') {
      return serveDashboard(env.KV, url.searchParams);
    }

    if (url.pathname === '/__baseline') {
      return serveBaseline(env, url.searchParams);
    }

    if (url.pathname === '/__backfill') {
      return backfillKvToSupabase(env, url.searchParams);
    }

    if (url.pathname === '/__revert') {
      return handleRevert(env, url.searchParams);
    }

    if (url.pathname === '/__clear-v1-keys') {
      const confirm = url.searchParams.get('confirm');
      if (confirm !== 'yes') {
        return new Response('Add ?confirm=yes to actually clear keys. This is destructive.', { status: 400 });
      }
      return clearV1Keys(env);
    }

    return new Response('Auto Turn-Off Worker. Use /__scheduled to trigger manually, /__baseline to capture a baseline.', { status: 200 });
  },
};

// ---------------------------------------------------------------------------
// Morning digest (12:00 UTC / 8am EDT)
// ---------------------------------------------------------------------------

async function executeMorningDigest(env: Env): Promise<void> {
  console.log(JSON.stringify({ event: 'digest_start', timestamp: new Date().toISOString() }));

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error('[digest] SUPABASE_URL/SUPABASE_ANON_KEY not set, skipping digest');
    return;
  }

  const sb = getSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  const isDryRun = env.DRY_RUN === 'true';

  for (const [cm, channel] of Object.entries(CM_MONITOR_CHANNELS)) {
    try {
      const summary = await getDashboardDigestData(sb, cm);
      const dashboardUrl = `${DASHBOARD_BASE_URL}/cm/${cm.toLowerCase()}`;
      await sendMorningDigest(channel, cm, dashboardUrl, summary, env.SLACK_BOT_TOKEN, isDryRun);
      console.log(`[digest] Sent to ${cm}: ${summary.activeCount} active, ${summary.criticalCount} critical`);
    } catch (err) {
      console.error(`[digest] Failed for ${cm}: ${err}`);
    }
  }

  console.log(JSON.stringify({ event: 'digest_complete', timestamp: new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// Extracted scheduled run body
// ---------------------------------------------------------------------------

async function executeScheduledRun(env: Env): Promise<void> {
    const runStart = Date.now();

    // --- Env var validation ---
    // Fail fast with descriptive errors rather than cryptic runtime failures.
    if (!env.INSTANTLY_API_KEYS) {
      throw new Error('[auto-turnoff] Missing required env var: INSTANTLY_API_KEYS');
    }
    if (!env.SLACK_BOT_TOKEN) {
      throw new Error('[auto-turnoff] Missing required env var: SLACK_BOT_TOKEN');
    }
    if (!env.KILLS_ENABLED) {
      throw new Error('[auto-turnoff] Missing required env var: KILLS_ENABLED (set to "true" or "false")');
    }
    if (!env.KV) {
      throw new Error('[auto-turnoff] Missing required binding: KV namespace');
    }

    console.log(JSON.stringify({
      event: 'run_start',
      timestamp: new Date().toISOString(),
      dryRun: env.DRY_RUN === 'true',
      killsEnabled: env.KILLS_ENABLED === 'true',
      mode: env.INSTANTLY_MODE || 'mcp',
    }));

    // 1. ACQUIRE LOCK
    const locked = await acquireLock(env.KV);
    if (!locked) {
      console.log('[auto-turnoff] Skipping: previous run still active (lock held < 30 min)');
      return;
    }

    // API client: direct mode bypasses MCP for fast endpoints (50x faster).
    const useDirectApi = env.INSTANTLY_MODE === 'direct' && env.INSTANTLY_API_KEYS;
    const mcp = new McpClient();
    const mcpApi = new InstantlyApi(mcp);
    const instantly = useDirectApi
      ? new InstantlyDirectApi(env.INSTANTLY_API_KEYS)
      : mcpApi;
    // leadsApi removed — leads now use batch direct API (getBatchCampaignAnalytics)

    // Supabase client (null if env vars not set -- graceful degradation)
    const sb: SupabaseClient | null = (env.SUPABASE_URL && env.SUPABASE_ANON_KEY)
      ? getSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
      : null;

    // Run summary counters
    let totalWorkspaces = 0;
    let totalCampaignsEvaluated = 0;
    let totalVariantsKilled = 0;
    let totalVariantsBlocked = 0;
    let totalVariantsWarned = 0;
    let totalVariantsDeferred = 0;
    let killBudgetRemaining = MAX_KILLS_PER_RUN > 0 ? MAX_KILLS_PER_RUN : Infinity;
    let totalErrors = 0;
    let totalRescanChecked = 0;
    let totalRescanReEnabled = 0;
    let totalExpired = 0;
    let totalCmOverride = 0;

    // Leads depletion monitor counters
    let totalLeadsChecked = 0;
    let totalLeadsWarnings = 0;
    let totalLeadsExhausted = 0;
    let totalLeadsRecovered = 0;

    // Candidates collected during Phase 1, processed in Phase 3
    const leadsCheckCandidates: LeadsCheckCandidate[] = [];

    // Dashboard state: collect BLOCKED, dry-run kills, and leads issues for Phase 5
    const dashboardBlocked: AuditEntry[] = [];
    const dashboardDryRunKills: AuditEntry[] = [];
    const dashboardLeadsExhausted: LeadsAuditEntry[] = [];
    const dashboardLeadsWarnings: LeadsAuditEntry[] = [];

    // Notification collector — groups Slack messages by (channel, type)
    const collector = new NotificationCollector();

    // Snapshot accumulator (zero extra API calls -- data collected during Phase 1)
    const snapshotAcc = {
      totalCampaigns: 0,
      totalSteps: 0,
      totalVariants: 0,
      activeVariants: 0,
      disabledVariants: 0,
      aboveThreshold: 0,
      byWorkspace: {} as Record<string, WorkspaceSnapshot>,
      byCm: {} as Record<string, CmSnapshot>,
      campaignHealth: [] as CampaignHealthEntry[],
    };

    // Higher concurrency for direct API (no shared SSE connection bottleneck)
    const concurrencyCap = useDirectApi
      ? Math.min(parseInt(env.CONCURRENCY_CAP, 10) || 10, 15)
      : Math.min(parseInt(env.CONCURRENCY_CAP, 10) || 3, 5);
    const isDryRun = env.DRY_RUN === 'true';

    try {
      // 2. CONNECT MCP (used when INSTANTLY_MODE=mcp; skipped in direct mode)
      if (!useDirectApi) {
        await mcp.connect();
      }

      // 3. GET MONITORED WORKSPACES
      const allWorkspaces = await instantly.listWorkspaces();
      const configuredIds = new Set(WORKSPACE_CONFIGS.map((c) => c.id));
      const monitoredWorkspaces = allWorkspaces.filter((ws) => configuredIds.has(ws.id));

      // Validate: warn if any configured ID is missing from API response
      const apiIds = new Set(allWorkspaces.map((ws) => ws.id));
      for (const config of WORKSPACE_CONFIGS) {
        if (!apiIds.has(config.id)) {
          console.warn(
            `[auto-turnoff] Configured workspace not found in API: id="${config.id}" name="${config.name}"`,
          );
        }
      }

      totalWorkspaces = monitoredWorkspaces.length;

      // Log breakdown by product
      const productCounts = { FUNDING: 0, ERC: 0, S125: 0 };
      for (const ws of monitoredWorkspaces) {
        const cfg = getWorkspaceConfig(ws.id);
        if (cfg) productCounts[cfg.product]++;
      }
      console.log(
        `[auto-turnoff] Processing ${totalWorkspaces} workspaces` +
          ` (${productCounts.FUNDING} Funding, ${productCounts.ERC} ERC,` +
          ` ${productCounts.S125} S125)`,
      );

      // 4. FOR EACH WORKSPACE (sequential)
      for (const workspace of monitoredWorkspaces) {
        const wsConfig = getWorkspaceConfig(workspace.id);
        if (!wsConfig) {
          console.warn(`[auto-turnoff] No config found for workspace id="${workspace.id}" — skipping`);
          continue;
        }

        // Pilot filter: skip dedicated workspaces whose default CM is not in the pilot
        if (!isPilotWorkspace(wsConfig)) {
          console.log(`[auto-turnoff] Skipping workspace ${workspace.name} — CM "${wsConfig.defaultCm}" not in pilot`);
          continue;
        }

        console.log(`[auto-turnoff] Processing workspace: ${workspace.name} [${wsConfig.product}]`);

        try {
          const allCampaigns = await instantly.getCampaigns(workspace.id);

          const activeCampaigns = allCampaigns;
          const offCount = allCampaigns.filter((c) => isOffCampaign(c.name)).length;

          console.log(
            `[auto-turnoff] ${activeCampaigns.length} campaigns` +
              (offCount > 0 ? ` (${offCount} OFF, buffered)` : '') +
              ` in ${workspace.name}`,
          );

          let workspaceKills = 0;
          let workspaceErrors = 0;

          // Process campaigns with concurrency cap
          await processWithConcurrency(activeCampaigns, concurrencyCap, async (campaign) => {
            // Resolve CM early — needed for pilot filter before expensive API calls
            const cmName = resolveCmName(wsConfig, campaign.name);

            // Pilot filter: skip campaigns whose CM is not in the pilot
            if (!isPilotCampaign(cmName)) return;

            // Per-CM dry run: evaluate and log but don't kill or notify
            const isDryRun = env.DRY_RUN === 'true' || DRY_RUN_CMS.has(cmName ?? '');

            try {
              totalCampaignsEvaluated++;

              // a. Get campaign details first (need sequences for kill writes)
              const campaignDetail = await instantly.getCampaignDetails(workspace.id, campaign.id);

              // b. Get step analytics (unfiltered -- date filters drop opps, see 2026-03-18 bug)
              const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id);

              // c. Sequences guard
              if (!campaignDetail.sequences?.length || !campaignDetail.sequences[0]?.steps?.length) {
                console.warn(`[auto-turnoff] Campaign ${campaign.id} (${campaign.name}) has no sequences, skipping`);
                return;
              }

              // d. Resolve threshold (needs campaign details for email_tag_list)
              const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV, isOffCampaign(campaign.name));
              if (threshold === null) {
                console.warn(
                  `[auto-turnoff] Could not resolve threshold for campaign "${campaign.name}" — skipping`,
                );
                return;
              }

              // Resolve channel based on CM name
              const channelId = resolveChannel(cmName, env.SLACK_FALLBACK_CHANNEL);

              const primaryStepCount = campaignDetail.sequences[0].steps.length;
              const primaryAnalytics = allAnalytics.filter(
                (a) => parseInt(a.step, 10) < primaryStepCount,
              );

              // --- SNAPSHOT COUNTING (no extra API calls) ---
              snapshotAcc.totalCampaigns++;
              let campTotal = 0, campActive = 0, campDisabled = 0, campAbove = 0;

              for (let si = 0; si < primaryStepCount; si++) {
                const snapStep = campaignDetail.sequences[0].steps[si];
                snapshotAcc.totalSteps++;

                for (let vi = 0; vi < snapStep.variants.length; vi++) {
                  campTotal++;
                  if (snapStep.variants[vi].v_disabled === true) {
                    campDisabled++;
                  } else {
                    campActive++;
                    const row = primaryAnalytics.find(
                      (a) => parseInt(a.step, 10) === si && parseInt(a.variant, 10) === vi,
                    );
                    if (row) {
                      const decision = evaluateVariant(row.sent, row.opportunities, threshold);
                      if (decision.action === 'KILL_CANDIDATE') {
                        campAbove++;
                      }
                    }
                  }
                }
              }

              snapshotAcc.totalVariants += campTotal;
              snapshotAcc.activeVariants += campActive;
              snapshotAcc.disabledVariants += campDisabled;
              snapshotAcc.aboveThreshold += campAbove;

              // Per-workspace snapshot
              if (!snapshotAcc.byWorkspace[workspace.id]) {
                snapshotAcc.byWorkspace[workspace.id] = { name: workspace.name, product: wsConfig.product, totalVariants: 0, activeVariants: 0, disabledVariants: 0, aboveThreshold: 0 };
              }
              snapshotAcc.byWorkspace[workspace.id].totalVariants += campTotal;
              snapshotAcc.byWorkspace[workspace.id].activeVariants += campActive;
              snapshotAcc.byWorkspace[workspace.id].disabledVariants += campDisabled;
              snapshotAcc.byWorkspace[workspace.id].aboveThreshold += campAbove;

              // Per-CM snapshot
              const cmKey = cmName ?? 'UNKNOWN';
              if (!snapshotAcc.byCm[cmKey]) {
                snapshotAcc.byCm[cmKey] = { totalVariants: 0, activeVariants: 0, disabledVariants: 0, aboveThreshold: 0 };
              }
              snapshotAcc.byCm[cmKey].totalVariants += campTotal;
              snapshotAcc.byCm[cmKey].activeVariants += campActive;
              snapshotAcc.byCm[cmKey].disabledVariants += campDisabled;
              snapshotAcc.byCm[cmKey].aboveThreshold += campAbove;

              // Campaign health
              const healthPct = campTotal > 0 ? ((campActive - campAbove) / campTotal) * 100 : 0;
              snapshotAcc.campaignHealth.push({
                campaignId: campaign.id,
                campaignName: campaign.name,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                cm: cmName,
                totalVariants: campTotal,
                activeVariants: campActive,
                disabledVariants: campDisabled,
                aboveThreshold: campAbove,
                healthPct: Math.round(healthPct * 10) / 10,
              });

              // --- LEADS DEPLETION: collect candidate for Phase 3 ---
              const dailyLimit = (campaignDetail as Record<string, unknown>).daily_limit as number | undefined;
              if (dailyLimit && dailyLimit > 0) {
                leadsCheckCandidates.push({
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                  campaignId: campaign.id,
                  campaignName: campaign.name,
                  cmName,
                  dailyLimit,
                  channelId,
                });
              } else {
                console.log(
                  `[auto-turnoff] Leads check: skipping "${campaign.name}" — no daily_limit set`,
                );
              }

              // e. Sanity check: Step 1 total sent should not exceed campaign contacted count.
              // The Instantly API sometimes returns inflated step analytics.
              const step1Analytics = allAnalytics.filter(a => parseInt(a.step, 10) === 0);
              const step1TotalSent = step1Analytics.reduce((sum, a) => sum + a.sent, 0);
              const campaignAnalytics = await instantly.getCampaignAnalytics(workspace.id, campaign.id);
              const contactedCount = campaignAnalytics.contacted;

              if (contactedCount > 0 && step1TotalSent > contactedCount * 1.1) {
                console.warn(
                  `[auto-turnoff] DATA INTEGRITY SKIP: "${campaign.name}" Step 1 sent (${step1TotalSent}) exceeds contacted (${contactedCount}) by ${Math.round((step1TotalSent / contactedCount - 1) * 100)}%. Skipping kill evaluation — data unreliable.`,
                );
                return;
              }

              // f. Quick gate: skip kill evaluation if no variant has reached the threshold
              const anyAboveThreshold = allAnalytics.some((a) => a.sent >= threshold);
              if (!anyAboveThreshold) {
                return;
              }

              // Collect kill candidates for batch execution after evaluation
              const pendingKills: Array<{
                kill: KillAction;
                auditEntry: AuditEntry;
                stepIndex: number;
                channelId: string;
              }> = [];

              // f. FOR EACH STEP in primary sequence
              for (let stepIndex = 0; stepIndex < primaryStepCount; stepIndex++) {
                const stepDetail = campaignDetail.sequences[0].steps[stepIndex];

                // Skip steps where all variants are already disabled
                if (stepDetail.variants.every((v) => v.v_disabled)) {
                  console.log(
                    `[auto-turnoff] Step ${stepIndex + 1} of "${campaign.name}" — all variants disabled, skipping`,
                  );
                  continue;
                }

                const stepAnalytics = primaryAnalytics.filter(
                  (a) => parseInt(a.step, 10) === stepIndex,
                );

                const { kills, blocked } = evaluateStep(
                  stepAnalytics,
                  stepDetail,
                  stepIndex,
                  threshold,
                );

                // Build set of all kill indices for accurate surviving count
                const allKillIndices = new Set(kills.map(k => k.variantIndex));

                // Process confirmed kills
                for (const kill of kills) {
                  // Defensive check — skip if variant is already disabled in campaign detail
                  if (stepDetail.variants[kill.variantIndex]?.v_disabled) {
                    console.log(
                      `[auto-turnoff] Variant ${kill.variantIndex} in step ${stepIndex + 1} of "${campaign.name}" is already disabled — skipping kill`,
                    );
                    continue;
                  }

                  const variantAnalytics = stepAnalytics.find(
                    (a) => parseInt(a.variant, 10) === kill.variantIndex,
                  );

                  const sent = variantAnalytics?.sent ?? 0;
                  const opportunities = variantAnalytics?.opportunities ?? 0;
                  const ratioValue =
                    opportunities === 0 ? 'Infinity' : (sent / opportunities).toFixed(1);

                  const survivingVariantCount = stepDetail.variants.filter(
                    (v, i) => !v.v_disabled && !allKillIndices.has(i),
                  ).length;

                  const killAction: KillAction = {
                    workspaceName: workspace.name,
                    workspaceId: workspace.id,
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    stepIndex,
                    variantIndex: kill.variantIndex,
                    sent,
                    opportunities,
                    ratio: ratioValue,
                    threshold,
                    notification: kill.notification,
                    survivingVariantCount,
                    isOff: isOffCampaign(campaign.name),
                  };

                  const effectiveThreshold = opportunities > 0
                    ? Math.round(threshold * OPP_RUNWAY_MULTIPLIER)
                    : threshold;
                  const triggerRule =
                    opportunities === 0
                      ? `${sent} sent, 0 opportunities past ${threshold} sends`
                      : `Ratio ${ratioValue}:1 exceeds threshold ${effectiveThreshold}:1`;

                  const auditEntry: AuditEntry = {
                    timestamp: new Date().toISOString(),
                    action: 'DISABLED',
                    workspace: workspace.name,
                    workspaceId: workspace.id,
                    campaign: campaign.name,
                    campaignId: campaign.id,
                    step: stepIndex + 1,
                    variant: kill.variantIndex,
                    variantLabel: VARIANT_LABELS[kill.variantIndex] ?? String(kill.variantIndex),
                    cm: cmName,
                    product: wsConfig.product,
                    trigger: { sent, opportunities, ratio: ratioValue, threshold, effective_threshold: effectiveThreshold, rule: triggerRule },
                    safety: { survivingVariants: survivingVariantCount, notification: kill.notification },
                    dryRun: isDryRun,
                  };

                  // Kill cap check: defer if we've hit the per-run limit
                  const killCapReached = killBudgetRemaining <= 0;

                  if (killCapReached && !isDryRun) {
                    totalVariantsDeferred++;
                    const deferredAudit: AuditEntry = {
                      ...auditEntry,
                      action: 'DEFERRED',
                    };
                    await writeAuditLog(env.KV, deferredAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write deferred audit log: ${err}`),
                    );
                    if (sb) await writeAuditLogToSupabase(sb, deferredAudit).catch((err) =>
                      console.error(`[supabase] deferred audit write failed: ${err}`),
                    );
                    console.log(
                      `[auto-turnoff] DEFERRED (kill cap ${MAX_KILLS_PER_RUN} reached): ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${kill.variantIndex} — will retry next run`,
                    );
                    continue;
                  }

                  if (isDryRun) {
                    await writeAuditLog(env.KV, auditEntry).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write audit log: ${err}`),
                    );
                    if (sb) await writeAuditLogToSupabase(sb, auditEntry).catch((err) =>
                      console.error(`[supabase] audit write failed: ${err}`),
                    );
                    // Collect for dashboard Action Required (per-CM dry run review)
                    if (DRY_RUN_CMS.has(cmName ?? '')) {
                      dashboardDryRunKills.push(auditEntry);
                    }
                    console.log(
                      `[DRY RUN] Would kill: ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${kill.variantIndex} → channel=${channelId || 'FALLBACK'} cm=${cmName ?? 'unknown'}`,
                    );
                    console.log(
                      `[DRY RUN] Decision — sent=${sent} opportunities=${opportunities} ratio=${ratioValue} threshold=${threshold} notification=${kill.notification ?? 'none'}`,
                    );
                    // Write rescan entry even in dry run (for testing rescan phase)
                    const rescanEntry: RescanEntry = {
                      workspaceId: workspace.id,
                      workspaceName: workspace.name,
                      campaignId: campaign.id,
                      campaignName: campaign.name,
                      stepIndex,
                      variantIndex: kill.variantIndex,
                      variantLabel: VARIANT_LABELS[kill.variantIndex] ?? String(kill.variantIndex),
                      disabledAt: new Date().toISOString(),
                      sent,
                      opportunities,
                      threshold,
                      cmName,
                      product: wsConfig.product,
                    };
                    await writeRescanEntry(env.KV, rescanEntry).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write rescan entry: ${err}`),
                    );
                  } else {
                    // Collect for batch execution (dedup check first)
                    const killDedupKey = `kill:${campaign.id}:${stepIndex}:${kill.variantIndex}`;
                    const alreadyKilled = await env.KV.get(killDedupKey);

                    if (!alreadyKilled) {
                      pendingKills.push({
                        kill: killAction,
                        auditEntry,
                        stepIndex,
                        channelId,
                      });
                      killBudgetRemaining--;
                    } else {
                      console.log(
                        `[auto-turnoff] Kill dedup: already notified for ${campaign.name} step=${stepIndex + 1} variant=${kill.variantIndex} — skipping`,
                      );
                    }
                  }
                }

                // Handle blocked variant (last variant — can't kill, notify CM)
                if (blocked) {
                  const variantAnalytics = stepAnalytics.find(
                    (a) => parseInt(a.variant, 10) === blocked.variantIndex,
                  );

                  const sent = variantAnalytics?.sent ?? 0;
                  const opportunities = variantAnalytics?.opportunities ?? 0;
                  const ratioValue =
                    opportunities === 0 ? 'Infinity' : (sent / opportunities).toFixed(1);

                  const blockedAction: KillAction = {
                    workspaceName: workspace.name,
                    workspaceId: workspace.id,
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    stepIndex,
                    variantIndex: blocked.variantIndex,
                    sent,
                    opportunities,
                    ratio: ratioValue,
                    threshold,
                    notification: 'LAST_VARIANT',
                    survivingVariantCount: 0,
                    isOff: isOffCampaign(campaign.name),
                  };

                  totalVariantsBlocked++;

                  const effectiveThresholdBlocked = opportunities > 0
                    ? Math.round(threshold * OPP_RUNWAY_MULTIPLIER)
                    : threshold;
                  const blockedTriggerRule =
                    opportunities === 0
                      ? `${sent} sent, 0 opportunities past ${threshold} sends`
                      : `Ratio ${ratioValue}:1 exceeds threshold ${effectiveThresholdBlocked}:1`;

                  // ALWAYS write audit entry for blocked variants (every run, not deduped)
                  const blockedAudit: AuditEntry = {
                    timestamp: new Date().toISOString(),
                    action: 'BLOCKED',
                    workspace: workspace.name,
                    workspaceId: workspace.id,
                    campaign: campaign.name,
                    campaignId: campaign.id,
                    step: stepIndex + 1,
                    variant: blocked.variantIndex,
                    variantLabel: VARIANT_LABELS[blocked.variantIndex] ?? String(blocked.variantIndex),
                    cm: cmName,
                    product: wsConfig.product,
                    trigger: { sent, opportunities, ratio: ratioValue, threshold, effective_threshold: effectiveThresholdBlocked, rule: blockedTriggerRule },
                    safety: { survivingVariants: 0, notification: 'LAST_VARIANT' },
                    dryRun: isDryRun,
                  };

                  await writeAuditLog(env.KV, blockedAudit).catch((err) =>
                    console.error(`[auto-turnoff] Failed to write audit log: ${err}`),
                  );
                  if (sb) await writeAuditLogToSupabase(sb, blockedAudit).catch((err) =>
                    console.error(`[supabase] blocked audit write failed: ${err}`),
                  );
                  dashboardBlocked.push(blockedAudit);

                  // Dedup: only NOTIFY once per blocked variant (audit writes above are unconditional)
                  const blockedDedupKey = `blocked:${campaign.id}:${stepIndex}:${blocked.variantIndex}`;
                  const alreadyBlocked = await env.KV.get(blockedDedupKey);

                  if (!alreadyBlocked) {
                    if (isDryRun || env.KILLS_ENABLED !== 'true') {
                      console.log(
                        `[${isDryRun ? 'DRY RUN' : 'KILLS PAUSED'}] BLOCKED (last variant): ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${blocked.variantIndex} → channel=${channelId || 'FALLBACK'} cm=${cmName ?? 'unknown'}`,
                      );
                      console.log(
                        `[${isDryRun ? 'DRY RUN' : 'KILLS PAUSED'}] Decision — sent=${sent} opportunities=${opportunities} ratio=${ratioValue} threshold=${threshold} — NOT killed, last active variant`,
                      );
                    } else {
                      collector.add(channelId, 'LAST_VARIANT', formatLastVariantDetails(blockedAction), {
                        timestamp: new Date().toISOString(),
                        notification_type: 'LAST_VARIANT',
                        campaign_id: campaign.id,
                        campaign_name: campaign.name,
                        workspace_id: workspace.id,
                        workspace_name: workspace.name,
                        cm: cmName,
                        step: stepIndex + 1,
                        variant: blocked.variantIndex,
                        variant_label: VARIANT_LABELS[blocked.variantIndex] ?? String(blocked.variantIndex),
                        dry_run: isDryRun,
                      });
                    }

                    // Write dedup key (7-day TTL, cleared if variant is no longer last active)
                    await env.KV.put(blockedDedupKey, JSON.stringify({
                      campaignId: campaign.id,
                      stepIndex,
                      variantIndex: blocked.variantIndex,
                      alertedAt: new Date().toISOString(),
                    }), { expirationTtl: 604800 }).catch(() => {});
                  }
                }

                // Clear blocked dedup keys if step is no longer in blocked state
                // (CM added new variants, so there are now multiple active variants)
                if (!blocked) {
                  for (let vi = 0; vi < stepDetail.variants.length; vi++) {
                    await env.KV.delete(`blocked:${campaign.id}:${stepIndex}:${vi}`).catch(() => {});
                  }
                }

                // Early warning check — for ALL active variants approaching threshold
                const killedIndices = kills.map((k) => k.variantIndex);
                const warnings = checkVariantWarnings(stepDetail, stepAnalytics, stepIndex, threshold, killedIndices, isOffCampaign(campaign.name));

                for (const warning of warnings) {
                  const dedupKey = `warning:${campaign.id}:${stepIndex}:${warning.variantIndex}`;
                  const alreadySent = await env.KV.get(dedupKey);

                  if (!alreadySent) {
                    totalVariantsWarned++;

                    const warningAudit: AuditEntry = {
                      timestamp: new Date().toISOString(),
                      action: 'WARNING',
                      workspace: workspace.name,
                      workspaceId: workspace.id,
                      campaign: campaign.name,
                      campaignId: campaign.id,
                      step: stepIndex + 1,
                      variant: warning.variantIndex,
                      variantLabel: warning.variantLabel,
                      cm: cmName,
                      product: wsConfig.product,
                      trigger: {
                        sent: warning.sent,
                        opportunities: warning.opportunities,
                        ratio: warning.opportunities === 0
                          ? 'Infinity'
                          : (warning.sent / warning.opportunities).toFixed(1),
                        threshold,
                        effective_threshold: warning.opportunities > 0
                          ? Math.round(threshold * OPP_RUNWAY_MULTIPLIER)
                          : threshold,
                        rule: `${warning.pctConsumed}% of threshold consumed (${warning.sent}/${threshold} sends)`,
                      },
                      safety: { survivingVariants: -1, notification: null },
                      dryRun: isDryRun,
                    };

                    await writeAuditLog(env.KV, warningAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write warning audit log: ${err}`),
                    );
                    if (sb) await writeAuditLogToSupabase(sb, warningAudit).catch((err) =>
                      console.error(`[supabase] warning audit write failed: ${err}`),
                    );

                    if (isDryRun) {
                      console.log(
                        `[DRY RUN] WARNING: ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${warning.variantIndex} — ${warning.pctConsumed}% consumed → channel=${channelId || 'FALLBACK'} cm=${cmName ?? 'unknown'}`,
                      );
                    } else {
                      collector.add(channelId, 'WARNING', formatWarningDetails(warning, campaign.name, workspace.name, stepIndex), {
                        timestamp: new Date().toISOString(),
                        notification_type: 'WARNING',
                        campaign_id: campaign.id,
                        campaign_name: campaign.name,
                        workspace_id: workspace.id,
                        workspace_name: workspace.name,
                        cm: cmName,
                        step: stepIndex + 1,
                        variant: warning.variantIndex,
                        variant_label: warning.variantLabel,
                        dry_run: isDryRun,
                      });
                      await env.KV.put(dedupKey, '1', { expirationTtl: WARNING_DEDUP_TTL_SECONDS });
                    }
                  }
                }
              }

              // --- BATCH KILL EXECUTION ---
              if (pendingKills.length > 0) {
                const killsEnabled = env.KILLS_ENABLED === 'true';

                if (!killsEnabled) {
                  for (const pk of pendingKills) {
                    // Write audit entry with BLOCKED action (kill was suppressed by KILLS_ENABLED=false)
                    const pausedAudit: AuditEntry = {
                      ...pk.auditEntry,
                      action: 'BLOCKED',
                      safety: {
                        ...pk.auditEntry.safety,
                        notification: pk.auditEntry.safety.notification ?? 'KILLS_PAUSED',
                      },
                    };
                    await writeAuditLog(env.KV, pausedAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write kills-paused audit log: ${err}`),
                    );
                    if (sb) await writeAuditLogToSupabase(sb, pausedAudit).catch((err) =>
                      console.error(`[supabase] kills-paused audit write failed: ${err}`),
                    );
                    dashboardBlocked.push(pausedAudit);
                    totalVariantsBlocked++;
                    console.log(
                      `[auto-turnoff] KILLS PAUSED: would disable ${campaign.name} Step ${pk.stepIndex + 1} Variant ${pk.kill.variantIndex} — logged as BLOCKED, skipping Instantly API call`,
                    );
                  }
                } else {
                  try {
                    // 1. Fetch FRESH campaign details (single read)
                    const freshDetail = await instantly.getCampaignDetails(workspace.id, campaign.id);
                    const cloned = structuredClone(freshDetail.sequences);

                    // 2. Apply all disables to the clone
                    for (const pk of pendingKills) {
                      const v = cloned?.[0]?.steps?.[pk.stepIndex]?.variants?.[pk.kill.variantIndex];
                      if (v) v.v_disabled = true;
                    }

                    // 3. Single update_campaign call
                    if (instantly instanceof InstantlyDirectApi) {
                      await instantly.updateCampaign(workspace.id, campaign.id, { sequences: cloned });
                    } else {
                      await mcp.callTool('update_campaign', {
                        workspace_id: workspace.id,
                        campaign_id: campaign.id,
                        updates: { sequences: cloned },
                      });
                    }

                    // 4. Single verification
                    const verified = await instantly.getCampaignDetails(workspace.id, campaign.id);

                    // 5. Check each variant individually
                    for (const pk of pendingKills) {
                      const v = verified.sequences?.[0]?.steps?.[pk.stepIndex]?.variants?.[pk.kill.variantIndex];
                      const isDisabled = v?.v_disabled === true;

                      if (isDisabled) {
                        workspaceKills++;
                        totalVariantsKilled++;

                        await writeAuditLog(env.KV, pk.auditEntry).catch((err) =>
                          console.error(`[auto-turnoff] Failed to write audit log: ${err}`),
                        );
                        if (sb) await writeAuditLogToSupabase(sb, pk.auditEntry).catch((err) =>
                          console.error(`[supabase] audit write failed: ${err}`),
                        );

                        const rescanEntry: RescanEntry = {
                          workspaceId: workspace.id,
                          workspaceName: workspace.name,
                          campaignId: campaign.id,
                          campaignName: campaign.name,
                          stepIndex: pk.stepIndex,
                          variantIndex: pk.kill.variantIndex,
                          variantLabel: VARIANT_LABELS[pk.kill.variantIndex] ?? String(pk.kill.variantIndex),
                          disabledAt: new Date().toISOString(),
                          sent: pk.kill.sent,
                          opportunities: pk.kill.opportunities,
                          threshold: pk.kill.threshold,
                          cmName,
                          product: wsConfig.product,
                        };
                        await writeRescanEntry(env.KV, rescanEntry).catch((err) =>
                          console.error(`[auto-turnoff] Failed to write rescan entry: ${err}`),
                        );

                        collector.add(pk.channelId, 'KILL', formatKillDetails(pk.kill), {
                          timestamp: new Date().toISOString(),
                          notification_type: 'KILL',
                          campaign_id: campaign.id,
                          campaign_name: campaign.name,
                          workspace_id: workspace.id,
                          workspace_name: workspace.name,
                          cm: cmName,
                          step: pk.stepIndex + 1,
                          variant: pk.kill.variantIndex,
                          variant_label: VARIANT_LABELS[pk.kill.variantIndex] ?? String(pk.kill.variantIndex),
                          dry_run: isDryRun,
                        });

                        // Write dedup key (7-day TTL, cleared if variant is re-enabled by rescan)
                        const killDedupKey = `kill:${campaign.id}:${pk.stepIndex}:${pk.kill.variantIndex}`;
                        await env.KV.put(killDedupKey, JSON.stringify({
                          campaignId: campaign.id,
                          stepIndex: pk.stepIndex,
                          variantIndex: pk.kill.variantIndex,
                          killedAt: new Date().toISOString(),
                        }), { expirationTtl: KILL_DEDUP_TTL_SECONDS }).catch(() => {});
                      } else {
                        console.warn(`[auto-turnoff] Batch verify failed: ${campaign.name} step=${pk.stepIndex} variant=${pk.kill.variantIndex}`);
                        workspaceErrors++;
                        totalErrors++;
                      }
                    }
                  } catch (batchErr) {
                    console.error(`[auto-turnoff] Batch kill failed for ${campaign.name}: ${batchErr}`);
                    // No fallback to individual kills (same race condition).
                    // Variants remain enabled and will be re-evaluated next cron run.
                    killBudgetRemaining += pendingKills.length;
                    workspaceErrors += pendingKills.length;
                    totalErrors += pendingKills.length;
                  }
                }
              }
            } catch (campaignErr) {
              console.error(
                `[auto-turnoff] Error processing campaign ${campaign.id} (${campaign.name}): ${campaignErr}`,
              );
              totalErrors++;
            }
          });

          console.log(JSON.stringify({
            event: 'workspace_complete',
            workspace: workspace.name,
            campaigns: activeCampaigns.length,
            kills: workspaceKills,
            errors: workspaceErrors,
            elapsedMs: Date.now() - runStart,
          }));

          // KV heartbeat every 10 campaigns (verifies KV writes work in prod)
          if (totalCampaignsEvaluated % 10 === 0 && totalCampaignsEvaluated > 0) {
            await env.KV.put('heartbeat', JSON.stringify({
              timestamp: new Date().toISOString(),
              campaignsProcessed: totalCampaignsEvaluated,
            }), { expirationTtl: 3600 }).catch(() => {});
          }
        } catch (wsErr) {
          console.error(
            `[auto-turnoff] Error processing workspace ${workspace.name} (${workspace.id}): ${wsErr}`,
          );
          totalErrors++;
        }
      }

      // 5. PHASE 2: RESCAN DISABLED VARIANTS FOR LATE-ARRIVING OPPORTUNITIES
      console.log(JSON.stringify({ event: 'phase_start', phase: 'rescan', elapsedMs: Date.now() - runStart }));
      try {
        const rescanKeys = await env.KV.list({ prefix: 'rescan:' });
        const totalInQueue = rescanKeys.keys.length;

        if (totalInQueue > 0) {
          console.log(`[auto-turnoff] Rescan: ${totalInQueue} entries in queue`);
        }

        for (const key of rescanKeys.keys) {
          const raw = await env.KV.get(key.name);
          if (!raw) continue;

          let entry: RescanEntry;
          try {
            entry = JSON.parse(raw) as RescanEntry;
          } catch {
            console.warn(`[auto-turnoff] Rescan: invalid JSON in ${key.name}, deleting`);
            await env.KV.delete(key.name);
            continue;
          }

          // Age check: only process entries >= RESCAN_DELAY_HOURS old
          const ageMs = Date.now() - new Date(entry.disabledAt).getTime();
          const ageHours = ageMs / 3_600_000;
          if (ageHours < RESCAN_DELAY_HOURS) continue;

          // Check for expiration (48h redemption window closed)
          if (ageHours >= RESCAN_MAX_WINDOW_HOURS) {
            totalRescanChecked++;
            totalExpired++;

            // Try to fetch current analytics for the audit log
            let expiredSent = entry.sent;
            let expiredOpps = entry.opportunities;
            let ruleNote = '';
            try {
              const freshAnalytics = await instantly.getStepAnalytics(
                entry.workspaceId, entry.campaignId,
              );
              const variantRow = freshAnalytics.find(
                (a) => parseInt(a.step, 10) === entry.stepIndex && parseInt(a.variant, 10) === entry.variantIndex,
              );
              if (variantRow) {
                expiredSent = variantRow.sent;
                expiredOpps = variantRow.opportunities;
              } else {
                ruleNote = ' (campaign may have been deleted)';
              }
            } catch {
              ruleNote = ' (could not fetch current analytics)';
            }

            const expiredAudit: AuditEntry = {
              timestamp: new Date().toISOString(),
              action: 'EXPIRED',
              workspace: entry.workspaceName,
              workspaceId: entry.workspaceId,
              campaign: entry.campaignName,
              campaignId: entry.campaignId,
              step: entry.stepIndex + 1,
              variant: entry.variantIndex,
              variantLabel: entry.variantLabel,
              cm: entry.cmName,
              product: entry.product,
              trigger: {
                sent: expiredSent,
                opportunities: expiredOpps,
                ratio: expiredOpps === 0 ? 'Infinity' : (expiredSent / expiredOpps).toFixed(1),
                threshold: entry.threshold,
                rule: `Redemption window expired after 48h (was ${entry.sent}/${entry.opportunities}, still ${expiredSent}/${expiredOpps})${ruleNote}`,
              },
              safety: { survivingVariants: -1, notification: null },
              dryRun: isDryRun,
            };

            await writeAuditLog(env.KV, expiredAudit).catch((err) =>
              console.error(`[auto-turnoff] Failed to write EXPIRED audit log: ${err}`),
            );
            if (sb) await writeAuditLogToSupabase(sb, expiredAudit).catch((err) =>
              console.error(`[supabase] expired audit write failed: ${err}`),
            );

            console.log(
              `[auto-turnoff] Rescan: EXPIRED ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel} (window closed after ${Math.round(ageHours)}h)`,
            );

            await env.KV.delete(key.name);
            continue;
          }

          totalRescanChecked++;
          const hoursRemaining = Math.round(48 - ageHours);

          console.log(
            `[auto-turnoff] Rescan: checking ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel} ` +
              `(disabled ${Math.round(ageHours)}h ago, was ${entry.sent}/${entry.opportunities})`
          );

          try {
            // Fetch campaign details (needed for re-enable if rescan passes)
            const campaignDetail = await instantly.getCampaignDetails(entry.workspaceId, entry.campaignId);

            // Fetch fresh analytics (unfiltered — validated as accurate)
            const freshAnalytics = await instantly.getStepAnalytics(
              entry.workspaceId, entry.campaignId,
            );
            const variantRow = freshAnalytics.find(
              (a) => parseInt(a.step, 10) === entry.stepIndex && parseInt(a.variant, 10) === entry.variantIndex,
            );

            if (!variantRow) {
              console.warn(
                `[auto-turnoff] Rescan: no analytics found for ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel}, removing from queue`,
              );
              await env.KV.delete(key.name);
              continue;
            }

            // Re-evaluate with current data
            const decision = evaluateVariant(variantRow.sent, variantRow.opportunities, entry.threshold);

            if (decision.action === 'KEEP') {
              const currentRatio = variantRow.opportunities === 0
                ? 'Infinity'
                : (variantRow.sent / variantRow.opportunities).toFixed(1);

              // Verify variant is still disabled before re-enabling (campaignDetail already fetched above)
              const variant = campaignDetail.sequences?.[0]?.steps?.[entry.stepIndex]?.variants?.[entry.variantIndex];

              if (!variant) {
                console.warn(
                  `[auto-turnoff] Rescan: variant no longer exists for ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel}, removing from queue`,
                );
                await env.KV.delete(key.name);
                continue;
              }

              if (variant.v_disabled !== true) {
                const overrideHoursAgo = Math.round(ageHours);

                const overrideAudit: AuditEntry = {
                  timestamp: new Date().toISOString(),
                  action: 'CM_OVERRIDE',
                  workspace: entry.workspaceName,
                  workspaceId: entry.workspaceId,
                  campaign: entry.campaignName,
                  campaignId: entry.campaignId,
                  step: entry.stepIndex + 1,
                  variant: entry.variantIndex,
                  variantLabel: entry.variantLabel,
                  cm: entry.cmName,
                  product: entry.product,
                  trigger: {
                    sent: entry.sent,
                    opportunities: entry.opportunities,
                    ratio: entry.opportunities === 0 ? 'Infinity' : (entry.sent / entry.opportunities).toFixed(1),
                    threshold: entry.threshold,
                    rule: `CM manually re-enabled variant during redemption window (${overrideHoursAgo}h after system disabled it)`,
                  },
                  safety: { survivingVariants: -1, notification: null },
                  dryRun: isDryRun,
                };

                await writeAuditLog(env.KV, overrideAudit).catch((err) =>
                  console.error(`[auto-turnoff] Failed to write CM_OVERRIDE audit log: ${err}`),
                );
                if (sb) await writeAuditLogToSupabase(sb, overrideAudit).catch((err) =>
                  console.error(`[supabase] cm_override audit write failed: ${err}`),
                );

                console.log(
                  `[auto-turnoff] Rescan: CM_OVERRIDE ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel} — CM re-enabled ${overrideHoursAgo}h after system disabled it`,
                );

                totalCmOverride++;
                await env.KV.delete(key.name);
                continue;
              }

              // Re-enable the variant
              if (isDryRun) {
                console.log(
                  `[DRY RUN] Rescan: would re-enable ${entry.workspaceName} / ${entry.campaignName} / Step ${entry.stepIndex + 1} Variant ${entry.variantLabel} ` +
                    `(was ${entry.sent}/${entry.opportunities}, now ${variantRow.sent}/${variantRow.opportunities}, ratio=${currentRatio})`,
                );
                totalRescanReEnabled++;
                await env.KV.delete(key.name);
              } else {
                console.log(
                  `[auto-turnoff] Rescan: RE-ENABLING ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel} ` +
                    `(was ${entry.sent}/${entry.opportunities}, now ${variantRow.sent}/${variantRow.opportunities}, ratio=${currentRatio})`,
                );

                const success = await instantly.enableVariant(
                  entry.workspaceId,
                  campaignDetail,
                  entry.stepIndex,
                  entry.variantIndex,
                );

                if (success) {
                  totalRescanReEnabled++;

                  const rescanChannelId = resolveChannel(entry.cmName, env.SLACK_FALLBACK_CHANNEL);
                  collector.add(rescanChannelId, 'RESCAN_RE_ENABLED', formatRescanDetails(entry, variantRow.opportunities, currentRatio), {
                    timestamp: new Date().toISOString(),
                    notification_type: 'RESCAN_RE_ENABLED',
                    campaign_id: entry.campaignId,
                    campaign_name: entry.campaignName,
                    workspace_id: entry.workspaceId,
                    workspace_name: entry.workspaceName,
                    cm: entry.cmName,
                    step: entry.stepIndex + 1,
                    variant: entry.variantIndex,
                    variant_label: entry.variantLabel,
                    dry_run: isDryRun,
                  });

                  await env.KV.delete(key.name);
                  // Clear kill dedup so a future re-kill can notify
                  await env.KV.delete(`kill:${entry.campaignId}:${entry.stepIndex}:${entry.variantIndex}`).catch(() => {});
                } else {
                  console.error(
                    `[auto-turnoff] Rescan: enableVariant returned false for ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel}`,
                  );
                }
              }

              // Write audit log for re-enable
              const reEnableAudit: AuditEntry = {
                timestamp: new Date().toISOString(),
                action: 'RE_ENABLED',
                workspace: entry.workspaceName,
                workspaceId: entry.workspaceId,
                campaign: entry.campaignName,
                campaignId: entry.campaignId,
                step: entry.stepIndex + 1,
                variant: entry.variantIndex,
                variantLabel: entry.variantLabel,
                cm: entry.cmName,
                product: entry.product,
                trigger: {
                  sent: variantRow.sent,
                  opportunities: variantRow.opportunities,
                  ratio: variantRow.opportunities === 0
                    ? 'Infinity'
                    : (variantRow.sent / variantRow.opportunities).toFixed(1),
                  threshold: entry.threshold,
                  rule: `Late opportunities improved ratio below threshold (was ${entry.opportunities} opps, now ${variantRow.opportunities})`,
                },
                safety: { survivingVariants: -1, notification: null },
                dryRun: isDryRun,
              };

              await writeAuditLog(env.KV, reEnableAudit).catch((err) =>
                console.error(`[auto-turnoff] Failed to write rescan audit log: ${err}`),
              );
              if (sb) await writeAuditLogToSupabase(sb, reEnableAudit).catch((err) =>
                console.error(`[supabase] re_enabled audit write failed: ${err}`),
              );
            } else {
              // Still failing
              console.log(
                `[auto-turnoff] Rescan: ${entry.campaignName} step=${entry.stepIndex + 1} variant=${entry.variantLabel} ` +
                  `still failing (${variantRow.sent}/${variantRow.opportunities}), keeping in queue (${hoursRemaining > 0 ? hoursRemaining + 'h until expiry' : 'expiring soon'})`,
              );
            }
          } catch (rescanErr) {
            console.error(
              `[auto-turnoff] Rescan error for ${entry.campaignName}: ${rescanErr}`,
            );
          }
        }

        if (totalRescanChecked > 0 || totalInQueue > 0) {
          console.log(
            `[auto-turnoff] Rescan complete: checked=${totalRescanChecked} reEnabled=${totalRescanReEnabled}`,
          );
        }
      } catch (rescanPhaseErr) {
        console.error(`[auto-turnoff] Rescan phase error: ${rescanPhaseErr}`);
      }

      // PHASE 3: LEADS DEPLETION MONITOR
      console.log(JSON.stringify({ event: 'phase_start', phase: 'leads', elapsedMs: Date.now() - runStart, candidates: leadsCheckCandidates.length }));
      let leadsCheckErrors = 0;
      try {
        if (leadsCheckCandidates.length === 0) {
          console.warn(`[auto-turnoff] Leads check: 0 candidates collected — campaigns may be missing daily_limit field. Evaluated ${totalCampaignsEvaluated} campaigns in Phase 1.`);
        } else {
          console.log(`[auto-turnoff] Leads check: evaluating ${leadsCheckCandidates.length} campaigns`);
        }

        // Batch fetch analytics for all workspaces with candidates (1 API call per workspace).
        // In direct mode, this replaces per-campaign MCP count_leads calls (MCP SSE fails from CF edge).
        const leadsBatchByWorkspace = new Map<string, Map<string, {
          leads_count: number; contacted: number; completed_count: number;
          bounced_count: number; unsubscribed_count: number;
        }>>();

        if (useDirectApi && leadsCheckCandidates.length > 0) {
          const directApi = instantly as InstantlyDirectApi;
          const workspaceIds = [...new Set(leadsCheckCandidates.map((c) => c.workspaceId))];
          for (const wsId of workspaceIds) {
            try {
              const batchMap = await directApi.getBatchCampaignAnalytics(wsId);
              leadsBatchByWorkspace.set(wsId, batchMap);
            } catch (batchErr) {
              console.error(`[auto-turnoff] Batch analytics fetch failed for workspace ${wsId}: ${batchErr}`);
            }
          }
        }

        for (const candidate of leadsCheckCandidates) {
          try {
            let totalLeads: number;
            let completed: number;
            let bounced: number;
            let unsubscribed: number;
            let skipped: number;
            let active: number;
            let contacted: number;
            let uncontacted: number;

            if (useDirectApi) {
              // Direct mode: derive from batch analytics (no MCP dependency).
              // active ≈ leads_count - completed - bounced - unsubscribed (skipped unavailable, typically <0.1%).
              // If analytics status fields are lifetime accumulators, active is understated → more false
              // warnings (safe direction). Clamped to 0 to prevent negative values from lead cycling.
              const wsMap = leadsBatchByWorkspace.get(candidate.workspaceId);
              const data = wsMap?.get(candidate.campaignId);
              if (!data) {
                console.warn(`[auto-turnoff] No batch analytics for campaign ${candidate.campaignId} — skipping leads check`);
                continue;
              }
              totalLeads = data.leads_count;
              completed = data.completed_count;
              bounced = data.bounced_count;
              unsubscribed = data.unsubscribed_count;
              skipped = 0; // Not available from analytics endpoint
              active = Math.max(0, totalLeads - completed - bounced - unsubscribed);
              contacted = completed + bounced + unsubscribed;
              uncontacted = active;
            } else {
              // MCP fallback: per-campaign count_leads call (used when INSTANTLY_MODE=mcp)
              const leadCounts = await mcpApi.countLeads(
                candidate.workspaceId,
                candidate.campaignId,
              );
              totalLeads = leadCounts.total_leads;
              const s = leadCounts.status;
              completed = s.completed;
              bounced = s.bounced;
              unsubscribed = s.unsubscribed;
              skipped = s.skipped;
              active = s.active;
              contacted = completed + bounced + skipped + unsubscribed;
              uncontacted = active;
            }

            // Evaluate
            const result = evaluateLeadDepletion(uncontacted, candidate.dailyLimit, totalLeads);
            totalLeadsChecked++;

            if (result.status === 'SKIPPED') {
              continue;
            }

            if (result.status === 'EXHAUSTED') {
              // Dashboard state: collect BEFORE dedup check (dedup gates Slack, not dashboard)
              dashboardLeadsExhausted.push({
                timestamp: new Date().toISOString(),
                action: 'LEADS_EXHAUSTED',
                workspace: candidate.workspaceName,
                workspaceId: candidate.workspaceId,
                campaign: candidate.campaignName,
                campaignId: candidate.campaignId,
                cm: candidate.cmName,
                leads: {
                  total: totalLeads,
                  contacted,
                  uncontacted,
                  completed,
                  active,
                  bounced,
                  skipped,
                  unsubscribed,
                  dailyLimit: candidate.dailyLimit,
                },
                dryRun: isDryRun,
              } as LeadsAuditEntry);

              // Check dedup: already alerted?
              const dedupKey = `leads-exhausted:${candidate.campaignId}`;
              const existing = await env.KV.get(dedupKey);
              if (existing) {
                continue; // Already alerted, skip
              }

              totalLeadsExhausted++;

              console.log(
                `[auto-turnoff] Leads EXHAUSTED: "${candidate.campaignName}" — 0 / ${totalLeads} leads remaining`,
              );

              // Write dedup entry
              const dedupEntry: LeadsExhaustedEntry = {
                campaignId: candidate.campaignId,
                campaignName: candidate.campaignName,
                workspaceId: candidate.workspaceId,
                workspaceName: candidate.workspaceName,
                cmName: candidate.cmName,
                alertedAt: new Date().toISOString(),
                totalLeads,
              };
              await env.KV.put(dedupKey, JSON.stringify(dedupEntry), {
                expirationTtl: LEADS_EXHAUSTED_DEDUP_TTL_SECONDS,
              });

              // Write audit log
              const auditEntry: LeadsAuditEntry = {
                timestamp: new Date().toISOString(),
                action: 'LEADS_EXHAUSTED',
                workspace: candidate.workspaceName,
                workspaceId: candidate.workspaceId,
                campaign: candidate.campaignName,
                campaignId: candidate.campaignId,
                cm: candidate.cmName,
                leads: {
                  total: totalLeads,
                  contacted,
                  uncontacted,
                  completed,
                  active,
                  bounced,
                  skipped,
                  unsubscribed,
                  dailyLimit: candidate.dailyLimit,
                },
                dryRun: isDryRun,
              };
              await env.KV.put(
                `log:${auditEntry.timestamp}:${candidate.campaignId}:leads`,
                JSON.stringify(auditEntry),
                { expirationTtl: 90 * 86400 },
              );
              if (sb) await writeLeadsAuditToSupabase(sb, auditEntry).catch((err) =>
                console.error(`[supabase] leads_exhausted audit write failed: ${err}`),
              );

              // Collect Slack notification
              collector.add(candidate.channelId, 'LEADS_EXHAUSTED', formatLeadsExhaustedDetails(candidate, totalLeads, active), {
                timestamp: new Date().toISOString(),
                notification_type: 'LEADS_EXHAUSTED',
                campaign_id: candidate.campaignId,
                campaign_name: candidate.campaignName,
                workspace_id: candidate.workspaceId,
                workspace_name: candidate.workspaceName,
                cm: candidate.cmName,
                step: null,
                variant: null,
                variant_label: null,
                dry_run: isDryRun,
              });

              // Clear any existing warning dedup (escalated to exhausted)
              await env.KV.delete(`leads-warning:${candidate.campaignId}`).catch(() => {});

            } else if (result.status === 'WARNING') {
              // Dashboard state: collect BEFORE dedup check
              dashboardLeadsWarnings.push({
                timestamp: new Date().toISOString(),
                action: 'LEADS_WARNING',
                workspace: candidate.workspaceName,
                workspaceId: candidate.workspaceId,
                campaign: candidate.campaignName,
                campaignId: candidate.campaignId,
                cm: candidate.cmName,
                leads: {
                  total: totalLeads,
                  contacted,
                  uncontacted,
                  completed,
                  active,
                  bounced,
                  skipped,
                  unsubscribed,
                  dailyLimit: candidate.dailyLimit,
                },
                dryRun: isDryRun,
              } as LeadsAuditEntry);

              // Check dedup: already alerted?
              const dedupKey = `leads-warning:${candidate.campaignId}`;
              const existing = await env.KV.get(dedupKey);
              if (existing) {
                continue; // Already alerted, skip
              }

              totalLeadsWarnings++;

              console.log(
                `[auto-turnoff] Leads WARNING: "${candidate.campaignName}" — ${uncontacted.toLocaleString()} / ${totalLeads.toLocaleString()} leads remaining (daily limit: ${candidate.dailyLimit.toLocaleString()})`,
              );

              // Write dedup entry
              const dedupEntry: LeadsWarningEntry = {
                campaignId: candidate.campaignId,
                campaignName: candidate.campaignName,
                workspaceId: candidate.workspaceId,
                workspaceName: candidate.workspaceName,
                cmName: candidate.cmName,
                alertedAt: new Date().toISOString(),
                uncontacted,
                totalLeads,
                dailyLimit: candidate.dailyLimit,
              };
              await env.KV.put(dedupKey, JSON.stringify(dedupEntry), {
                expirationTtl: LEADS_WARNING_DEDUP_TTL_SECONDS,
              });

              // Write audit log
              const auditEntry: LeadsAuditEntry = {
                timestamp: new Date().toISOString(),
                action: 'LEADS_WARNING',
                workspace: candidate.workspaceName,
                workspaceId: candidate.workspaceId,
                campaign: candidate.campaignName,
                campaignId: candidate.campaignId,
                cm: candidate.cmName,
                leads: {
                  total: totalLeads,
                  contacted,
                  uncontacted,
                  completed,
                  active,
                  bounced,
                  skipped,
                  unsubscribed,
                  dailyLimit: candidate.dailyLimit,
                },
                dryRun: isDryRun,
              };
              await env.KV.put(
                `log:${auditEntry.timestamp}:${candidate.campaignId}:leads`,
                JSON.stringify(auditEntry),
                { expirationTtl: 90 * 86400 },
              );
              if (sb) await writeLeadsAuditToSupabase(sb, auditEntry).catch((err) =>
                console.error(`[supabase] leads_warning audit write failed: ${err}`),
              );

              // Collect Slack notification
              collector.add(candidate.channelId, 'LEADS_WARNING', formatLeadsWarningDetails(candidate, uncontacted, totalLeads), {
                timestamp: new Date().toISOString(),
                notification_type: 'LEADS_WARNING',
                campaign_id: candidate.campaignId,
                campaign_name: candidate.campaignName,
                workspace_id: candidate.workspaceId,
                workspace_name: candidate.workspaceName,
                cm: candidate.cmName,
                step: null,
                variant: null,
                variant_label: null,
                dry_run: isDryRun,
              });

            } else {
              // HEALTHY: clear any existing dedup keys (state recovered)
              const warningKey = `leads-warning:${candidate.campaignId}`;
              const exhaustedKey = `leads-exhausted:${candidate.campaignId}`;

              const hadWarning = await env.KV.get(warningKey);
              const hadExhausted = await env.KV.get(exhaustedKey);

              if (hadWarning || hadExhausted) {
                totalLeadsRecovered++;

                console.log(
                  `[auto-turnoff] Leads RECOVERED: "${candidate.campaignName}" — ${uncontacted.toLocaleString()} / ${totalLeads.toLocaleString()} leads remaining`,
                );

                // Write recovery audit log
                const auditEntry: LeadsAuditEntry = {
                  timestamp: new Date().toISOString(),
                  action: 'LEADS_RECOVERED',
                  workspace: candidate.workspaceName,
                  workspaceId: candidate.workspaceId,
                  campaign: candidate.campaignName,
                  campaignId: candidate.campaignId,
                  cm: candidate.cmName,
                  leads: {
                    total: totalLeads,
                    contacted,
                    uncontacted,
                    completed,
                    active,
                    bounced,
                    skipped,
                    unsubscribed,
                    dailyLimit: candidate.dailyLimit,
                  },
                  dryRun: isDryRun,
                };
                await env.KV.put(
                  `log:${auditEntry.timestamp}:${candidate.campaignId}:leads`,
                  JSON.stringify(auditEntry),
                  { expirationTtl: 90 * 86400 },
                );
                if (sb) await writeLeadsAuditToSupabase(sb, auditEntry).catch((err) =>
                  console.error(`[supabase] leads_recovered audit write failed: ${err}`),
                );

                await env.KV.delete(warningKey).catch(() => {});
                await env.KV.delete(exhaustedKey).catch(() => {});
              }
            }
          } catch (err) {
            leadsCheckErrors++;
            console.warn(
              `[auto-turnoff] Leads check failed for "${candidate.campaignName}": ${err}`,
            );
          }
        }

        if (leadsCheckErrors > 0) {
          console.warn(
            `[auto-turnoff] Leads check: ${leadsCheckErrors}/${leadsCheckCandidates.length} campaigns failed`,
          );
        }

        if (totalLeadsChecked > 0) {
          console.log(
            `[auto-turnoff] Leads check complete: checked=${totalLeadsChecked} warnings=${totalLeadsWarnings} exhausted=${totalLeadsExhausted} recovered=${totalLeadsRecovered}`,
          );
        }
      } catch (leadsPhaseErr) {
        console.error(`[auto-turnoff] Leads depletion phase error: ${leadsPhaseErr}`);
      }

      // -----------------------------------------------------------------------
      // PHASE 4: KILL PERSISTENCE MONITOR
      // -----------------------------------------------------------------------
      console.log(JSON.stringify({ event: 'phase_start', phase: 'persistence', elapsedMs: Date.now() - runStart }));
      let ghostCount = 0;
      let persistenceChecks = 0;

      try {
        // 1. List all kill dedup keys from KV
        const killKeys = await env.KV.list({ prefix: 'kill:' });

        // 2. Group by campaignId
        const killsByCampaign = new Map<string, Array<{
          key: string;
          campaignId: string;
          stepIndex: number;
          variantIndex: number;
          killedAt: string;
        }>>();

        for (const key of killKeys.keys) {
          if (persistenceChecks >= MAX_PERSISTENCE_CHECKS) break;

          const raw = await env.KV.get(key.name);
          if (!raw) continue;

          try {
            const data = JSON.parse(raw) as {
              campaignId: string;
              stepIndex: number;
              variantIndex: number;
              killedAt: string;
            };

            const list = killsByCampaign.get(data.campaignId) ?? [];
            list.push({ key: key.name, ...data });
            killsByCampaign.set(data.campaignId, list);
            persistenceChecks++;
          } catch { continue; }
        }

        // 3. For each campaign, check if kills persisted
        for (const [campaignId, kills] of killsByCampaign) {
          const firstKill = kills[0];
          // Resolve workspace from rescan entry
          const rescanKey = `rescan:${campaignId}:${firstKill.stepIndex}:${firstKill.variantIndex}`;
          const rescanRaw = await env.KV.get(rescanKey);
          let workspaceId: string | null = null;
          let workspaceName = '';
          let cmName: string | null = null;
          let campaignName = '';
          let product: string = 'FUNDING';

          if (rescanRaw) {
            try {
              const rescan = JSON.parse(rescanRaw) as RescanEntry;
              workspaceId = rescan.workspaceId;
              workspaceName = rescan.workspaceName;
              cmName = rescan.cmName;
              campaignName = rescan.campaignName;
              product = rescan.product;
            } catch { /* skip */ }
          }

          if (!workspaceId) {
            console.log(`[auto-turnoff] Persistence check: no workspace found for campaign ${campaignId}, skipping`);
            continue;
          }

          try {
            const detail = await instantly.getCampaignDetails(workspaceId, campaignId);
            campaignName = campaignName || detail.name;

            for (const kill of kills) {
              const variant = detail.sequences?.[0]?.steps?.[kill.stepIndex]?.variants?.[kill.variantIndex];
              if (!variant) continue;

              if (variant.v_disabled !== true) {
                // GHOST RE-ENABLE DETECTED
                ghostCount++;
                const variantLabel = VARIANT_LABELS[kill.variantIndex] ?? String(kill.variantIndex);

                console.warn(
                  `[auto-turnoff] GHOST RE-ENABLE: ${campaignName} Step ${kill.stepIndex + 1} ` +
                  `Variant ${variantLabel} was disabled at ${kill.killedAt} but is now enabled`
                );

                const ghostAudit: AuditEntry = {
                  timestamp: new Date().toISOString(),
                  action: 'GHOST_REENABLE',
                  workspace: workspaceName,
                  workspaceId,
                  campaign: campaignName,
                  campaignId,
                  step: kill.stepIndex + 1,
                  variant: kill.variantIndex,
                  variantLabel,
                  cm: cmName,
                  product: product as any,
                  trigger: {
                    sent: 0,
                    opportunities: 0,
                    ratio: '0',
                    threshold: 0,
                    rule: `Ghost re-enable: disabled at ${kill.killedAt}, found enabled at ${new Date().toISOString()}`,
                  },
                  safety: {
                    survivingVariants: -1,
                    notification: null,
                  },
                  dryRun: isDryRun,
                };

                await writeAuditLog(env.KV, ghostAudit).catch(() => {});
                if (sb) await writeAuditLogToSupabase(sb, ghostAudit).catch(() => {});

                // Clean up the kill dedup key since the variant is no longer disabled
                await env.KV.delete(kill.key).catch(() => {});
              }
            }
          } catch (err) {
            console.error(`[auto-turnoff] Persistence check failed for campaign ${campaignId}: ${err}`);
          }
        }
      } catch (err) {
        console.error(`[auto-turnoff] Phase 4 persistence monitor error: ${err}`);
      }

      if (ghostCount > 0) {
        console.warn(`[auto-turnoff] Phase 4 complete: ${ghostCount} ghost re-enables detected`);
      } else {
        console.log(`[auto-turnoff] Phase 4 complete: all ${persistenceChecks} kills verified persistent`);
      }

      // PHASE 5: BUILD DASHBOARD STATE
      console.log(JSON.stringify({ event: 'phase_start', phase: 'dashboard_state', elapsedMs: Date.now() - runStart }));
      if (sb) {
        try {
          const dashResult = await buildDashboardState(
            sb,
            new Date().toISOString(),
            dashboardBlocked,
            dashboardLeadsExhausted,
            dashboardLeadsWarnings,
            dashboardDryRunKills,
          );
          console.log(`[auto-turnoff] Dashboard state: ${dashResult.upserted} upserted, ${dashResult.resolved} resolved`);
        } catch (dashErr) {
          console.error(`[auto-turnoff] Dashboard state error: ${dashErr}`);
        }
      }

      // 5b. FLUSH NOTIFICATIONS (Slack suppressed — digest-only mode; data still written to Supabase)
      console.log(JSON.stringify({ event: 'phase_start', phase: 'notifications', pending: collector.size, elapsedMs: Date.now() - runStart }));
      try {
        const flushResults = await collector.flush(env.SLACK_BOT_TOKEN, isDryRun, /* skipSlack */ true);
        let totalNotificationsSent = 0;
        for (const group of flushResults) {
          totalNotificationsSent += group.items.length;
          console.log(`[auto-turnoff] Notifications: ${group.type} → ${group.items.length} items → channel=${group.channelId} thread=${group.threadTs ?? 'none'}`);

          // Write individual Supabase notification records with group thread_ts
          if (sb) {
            for (const item of group.items) {
              await writeNotificationToSupabase(sb, {
                ...item.meta,
                channel_id: group.channelId,
                title: group.title,
                details: item.detail,
                thread_ts: group.threadTs,
                reply_success: item.replySuccess,
              }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));
            }
          }
        }
        console.log(`[auto-turnoff] Notifications complete: ${totalNotificationsSent} items across ${flushResults.length} groups`);
      } catch (notifyErr) {
        console.error(`[auto-turnoff] Notification flush error: ${notifyErr}`);
      }

      // 6. WRITE DAILY SNAPSHOT
      const snapshotDate = new Date().toISOString().slice(0, 10);
      const dailySnapshot: DailySnapshot = {
        date: snapshotDate,
        capturedAt: new Date().toISOString(),
        totalCampaigns: snapshotAcc.totalCampaigns,
        totalSteps: snapshotAcc.totalSteps,
        totalVariants: snapshotAcc.totalVariants,
        activeVariants: snapshotAcc.activeVariants,
        disabledVariants: snapshotAcc.disabledVariants,
        aboveThreshold: snapshotAcc.aboveThreshold,
        actionsToday: {
          disabled: totalVariantsKilled,
          blocked: totalVariantsBlocked,
          warned: totalVariantsWarned,
          reEnabled: totalRescanReEnabled,
          expired: totalExpired,
          cmOverride: totalCmOverride,
        },
        byWorkspace: snapshotAcc.byWorkspace,
        byCm: snapshotAcc.byCm,
        campaignHealth: snapshotAcc.campaignHealth
          .sort((a, b) => a.healthPct - b.healthPct)
          .slice(0, 100),
      };

      await env.KV.put(`snapshot:${snapshotDate}`, JSON.stringify(dailySnapshot), { expirationTtl: 90 * 86400 }).catch((err) =>
        console.error(`[auto-turnoff] Failed to write daily snapshot: ${err}`),
      );
      if (sb) await writeDailySnapshotToSupabase(sb, dailySnapshot).catch((err) =>
        console.error(`[supabase] daily snapshot write failed: ${err}`),
      );

      console.log(
        `[auto-turnoff] Snapshot: ${dailySnapshot.totalVariants} total, ${dailySnapshot.activeVariants} active, ${dailySnapshot.disabledVariants} disabled, ${dailySnapshot.aboveThreshold} above threshold`,
      );

      // 7. LOG RUN SUMMARY
      const durationMs = Date.now() - runStart;
      console.log(
        `[auto-turnoff] Run complete — workspaces=${totalWorkspaces} campaigns=${totalCampaignsEvaluated} killed=${totalVariantsKilled} deferred=${totalVariantsDeferred} blocked=${totalVariantsBlocked} warned=${totalVariantsWarned} rescan=${totalRescanChecked} reEnabled=${totalRescanReEnabled} expired=${totalExpired} cmOverride=${totalCmOverride} errors=${totalErrors} leads: checked=${totalLeadsChecked} leadsErrors=${leadsCheckErrors} warnings=${totalLeadsWarnings} exhausted=${totalLeadsExhausted} recovered=${totalLeadsRecovered} ${durationMs}ms`,
      );

      // 8. WRITE RUN SUMMARY TO KV
      const runSummary: RunSummary = {
        timestamp: new Date().toISOString(),
        workspacesProcessed: totalWorkspaces,
        campaignsEvaluated: totalCampaignsEvaluated,
        variantsDisabled: totalVariantsKilled,
        variantsBlocked: totalVariantsBlocked,
        variantsWarned: totalVariantsWarned,
        errors: totalErrors,
        durationMs,
        rescanChecked: totalRescanChecked,
        rescanReEnabled: totalRescanReEnabled,
        rescanExpired: totalExpired,
        rescanCmOverride: totalCmOverride,
        leadsChecked: totalLeadsChecked,
        leadsCheckErrors,
        leadsWarnings: totalLeadsWarnings,
        leadsExhausted: totalLeadsExhausted,
        leadsRecovered: totalLeadsRecovered,
        ghostReEnables: ghostCount,
        dryRun: isDryRun,
      };

      await writeRunSummary(env.KV, runSummary).catch((err) =>
        console.error(`[auto-turnoff] Failed to write run summary: ${err}`),
      );
      if (sb) await writeRunSummaryToSupabase(sb, runSummary).catch((err) =>
        console.error(`[supabase] run summary write failed: ${err}`),
      );
    } finally {
      // RELEASE LOCK
      await releaseLock(env.KV).catch((err) =>
        console.error(`[auto-turnoff] Failed to release lock: ${err}`),
      );

      // CLOSE MCP (no-op if never connected)
      await mcp.close().catch((err) =>
        console.error(`[auto-turnoff] Failed to close MCP client: ${err}`),
      );
    }
}

// ---------------------------------------------------------------------------
// One-time KV -> Supabase backfill (runs inside worker, no rate limits)
// ---------------------------------------------------------------------------

async function backfillKvToSupabase(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return new Response('SUPABASE_URL/SUPABASE_ANON_KEY not set', { status: 500 });
  }
  const sb = getSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

  // Paginated: ?prefix=log:&cursor=xxx&limit=200
  const prefix = params.get('prefix') || 'log:';
  const inCursor = params.get('cursor') || undefined;
  const limit = Math.min(parseInt(params.get('limit') || '200', 10), 500);

  const stats = { processed: 0, errors: 0, prefix };

  const list = await env.KV.list({ prefix, cursor: inCursor, limit });

  const promises = list.keys.map(async (k) => {
    try {
      const raw = await env.KV.get(k.name);
      if (!raw) return;
      const entry = JSON.parse(raw);

      if (prefix === 'log:') {
        if (k.name.endsWith(':leads')) {
          await writeLeadsAuditToSupabase(sb, entry);
        } else {
          await writeAuditLogToSupabase(sb, entry);
        }
      } else if (prefix === 'run:') {
        await writeRunSummaryToSupabase(sb, entry as RunSummary);
      } else if (prefix === 'snapshot:') {
        await writeDailySnapshotToSupabase(sb, entry as DailySnapshot);
      }
      stats.processed++;
    } catch (err) {
      stats.errors++;
      console.error(`[backfill] Error processing ${k.name}: ${err}`);
    }
  });
  await Promise.all(promises);

  const nextCursor = list.list_complete ? null : list.cursor;

  return new Response(JSON.stringify({ ...stats, nextCursor, done: list.list_complete }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
