import { McpClient } from './mcp-client';
import { InstantlyApi } from './instantly';
import { evaluateStep, evaluateVariant, checkVariantWarnings } from './evaluator';
import { resolveChannel, resolveCmName, isPilotCampaign, isPilotWorkspace } from './router';
import {
  sendKillNotification, sendLastVariantNotification, sendWarningNotification,
  sendRescanNotification, sendLeadsWarningNotification, sendLeadsExhaustedNotification,
  formatKillTitle, formatKillDetails, formatLastVariantTitle, formatLastVariantDetails,
  formatWarningTitle, formatWarningDetails, formatRescanTitle, formatRescanDetails,
  formatLeadsWarningTitle, formatLeadsWarningDetails, formatLeadsExhaustedTitle, formatLeadsExhaustedDetails,
} from './slack';
import {
  getSupabaseClient, writeAuditLogToSupabase, writeLeadsAuditToSupabase,
  writeRunSummaryToSupabase, writeDailySnapshotToSupabase, writeNotificationToSupabase,
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
} from './config';
import { resolveThreshold } from './thresholds';
import { serveDashboard } from './dashboard';
import type {
  Env, KillAction, CampaignDetail, StepAnalytics, AuditEntry, RunSummary, RescanEntry,
  DailySnapshot, BaselineSnapshot, WorkspaceSnapshot, CmSnapshot, CampaignHealthEntry,
  LeadsCheckCandidate, LeadsWarningEntry, LeadsExhaustedEntry, LeadsAuditEntry,
} from './types';

import { computeStep0Sent, computeUncontacted, evaluateLeadDepletion } from './leads-monitor';

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
      const activeCampaigns = campaigns.filter((c) => !isOffCampaign(c.name));

      if (!acc.byWorkspace[workspace.id]) {
        acc.byWorkspace[workspace.id] = {
          name: workspace.name, product: wsConfig.product,
          totalVariants: 0, activeVariants: 0, disabledVariants: 0, aboveThreshold: 0,
        };
      }

      for (const campaign of activeCampaigns) {
        try {
          const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id);
          const campaignDetail = await instantly.getCampaignDetails(workspace.id, campaign.id);

          if (!campaignDetail.sequences?.length || !campaignDetail.sequences[0]?.steps?.length) continue;

          const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV);
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
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const runStart = Date.now();

    // 1. ACQUIRE LOCK
    const locked = await acquireLock(env.KV);
    if (!locked) {
      console.log('[auto-turnoff] Skipping: previous run still active (lock held < 30 min)');
      return;
    }

    const mcp = new McpClient();
    const instantly = new InstantlyApi(mcp);

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

    // Snapshot accumulator (zero extra API calls — data collected during Phase 1)
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

    const concurrencyCap = parseInt(env.CONCURRENCY_CAP, 10) || 3;
    const isDryRun = env.DRY_RUN === 'true';

    try {
      // 2. CONNECT MCP
      await mcp.connect();

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

          // OFF campaign filter pass
          const activeCampaigns = allCampaigns.filter((c) => !isOffCampaign(c.name));
          const skippedOff = allCampaigns.length - activeCampaigns.length;

          console.log(
            `[auto-turnoff] ${activeCampaigns.length} active campaigns` +
              (skippedOff > 0 ? ` (${skippedOff} skipped OFF)` : '') +
              ` in ${workspace.name}`,
          );

          let workspaceKills = 0;
          let workspaceErrors = 0;

          // Process campaigns with concurrency cap
          await processWithConcurrency(activeCampaigns, concurrencyCap, async (campaign) => {
            // Double-check OFF filter inside concurrency worker (defensive)
            if (isOffCampaign(campaign.name)) return;

            // Resolve CM early — needed for pilot filter before expensive API calls
            const cmName = resolveCmName(wsConfig, campaign.name);

            // Pilot filter: skip campaigns whose CM is not in the pilot
            if (!isPilotCampaign(cmName)) return;

            try {
              totalCampaignsEvaluated++;

              // a. Get step analytics
              const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id);

              // b. Get campaign details (needed before threshold resolution)
              const campaignDetail = await instantly.getCampaignDetails(workspace.id, campaign.id);

              // c. Sequences guard
              if (!campaignDetail.sequences?.length || !campaignDetail.sequences[0]?.steps?.length) {
                console.warn(`[auto-turnoff] Campaign ${campaign.id} (${campaign.name}) has no sequences, skipping`);
                return;
              }

              // d. Resolve threshold (needs campaign details for email_tag_list)
              const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV);
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
                const step0Sent = computeStep0Sent(allAnalytics);
                leadsCheckCandidates.push({
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                  campaignId: campaign.id,
                  campaignName: campaign.name,
                  cmName,
                  dailyLimit,
                  step0Sent,
                  channelId,
                });
              } else {
                console.log(
                  `[auto-turnoff] Leads check: skipping "${campaign.name}" — no daily_limit set`,
                );
              }

              // e. Quick gate: skip kill evaluation if no variant has reached the threshold
              const anyAboveThreshold = allAnalytics.some((a) => a.sent >= threshold);
              if (!anyAboveThreshold) {
                return;
              }

              // f. FOR EACH STEP in primary sequence
              for (let stepIndex = 0; stepIndex < primaryStepCount; stepIndex++) {
                const stepDetail = campaignDetail.sequences[0].steps[stepIndex];

                const stepAnalytics = primaryAnalytics.filter(
                  (a) => parseInt(a.step, 10) === stepIndex,
                );

                const { kills, blocked } = evaluateStep(
                  stepAnalytics,
                  stepDetail,
                  stepIndex,
                  threshold,
                );

                // Process confirmed kills
                for (const kill of kills) {
                  const variantAnalytics = stepAnalytics.find(
                    (a) => parseInt(a.variant, 10) === kill.variantIndex,
                  );

                  const sent = variantAnalytics?.sent ?? 0;
                  const opportunities = variantAnalytics?.opportunities ?? 0;
                  const ratioValue =
                    opportunities === 0 ? 'Infinity' : (sent / opportunities).toFixed(1);

                  const survivingVariantCount = stepDetail.variants.filter(
                    (v, i) => v.v_disabled !== true && i !== kill.variantIndex,
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
                  };

                  const triggerRule =
                    opportunities === 0
                      ? `${sent} sent, 0 opportunities past ${threshold} sends`
                      : `Ratio ${ratioValue}:1 exceeds threshold ${threshold}:1`;

                  const auditEntry: AuditEntry = {
                    timestamp: new Date().toISOString(),
                    action: 'DISABLED',
                    workspace: workspace.name,
                    workspaceId: workspace.id,
                    campaign: campaign.name,
                    campaignId: campaign.id,
                    step: stepIndex,
                    variant: kill.variantIndex,
                    variantLabel: VARIANT_LABELS[kill.variantIndex] ?? String(kill.variantIndex),
                    cm: cmName,
                    product: wsConfig.product,
                    trigger: { sent, opportunities, ratio: ratioValue, threshold, rule: triggerRule },
                    safety: { survivingVariants: survivingVariantCount, notification: kill.notification },
                    dryRun: isDryRun,
                  };

                  // Kill cap check: defer if we've hit the per-run limit
                  const killCapReached = MAX_KILLS_PER_RUN > 0 && totalVariantsKilled >= MAX_KILLS_PER_RUN;

                  if (killCapReached && !isDryRun) {
                    totalVariantsDeferred++;
                    const deferredAudit: AuditEntry = {
                      ...auditEntry,
                      action: 'DEFERRED',
                    };
                    await writeAuditLog(env.KV, deferredAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write deferred audit log: ${err}`),
                    );
                    if (sb) writeAuditLogToSupabase(sb, deferredAudit).catch((err) =>
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
                    if (sb) writeAuditLogToSupabase(sb, auditEntry).catch((err) =>
                      console.error(`[supabase] audit write failed: ${err}`),
                    );
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
                    try {
                      const killsEnabled = env.KILLS_ENABLED === 'true';

                      const success = killsEnabled
                        ? await instantly.disableVariant(
                            workspace.id,
                            campaignDetail,
                            stepIndex,
                            kill.variantIndex,
                          )
                        : false;

                      if (!killsEnabled) {
                        console.log(
                          `[auto-turnoff] KILLS PAUSED: would disable ${campaign.name} Step ${stepIndex + 1} Variant ${kill.variantIndex} — skipping Instantly API call`,
                        );
                      }

                      if (success) {
                        // Dedup: only notify once per killed variant
                        const killDedupKey = `kill:${campaign.id}:${stepIndex}:${kill.variantIndex}`;
                        const alreadyKilled = await env.KV.get(killDedupKey);

                        if (!alreadyKilled) {
                          workspaceKills++;
                          totalVariantsKilled++;

                          await writeAuditLog(env.KV, auditEntry).catch((err) =>
                            console.error(`[auto-turnoff] Failed to write audit log: ${err}`),
                          );
                          if (sb) writeAuditLogToSupabase(sb, auditEntry).catch((err) =>
                            console.error(`[supabase] audit write failed: ${err}`),
                          );

                          // Queue for secondary rescan
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

                          const killSlackResult = await sendKillNotification(killAction, channelId, env).catch((slackErr) => {
                            console.error(
                              `[auto-turnoff] Slack notification failed for ${campaign.name} step=${stepIndex} variant=${kill.variantIndex}: ${slackErr}`,
                            );
                            return { threadTs: null, replySuccess: false };
                          });
                          if (sb) writeNotificationToSupabase(sb, {
                            timestamp: new Date().toISOString(),
                            notification_type: 'KILL',
                            channel_id: channelId,
                            title: formatKillTitle(killAction),
                            details: formatKillDetails(killAction),
                            thread_ts: killSlackResult.threadTs,
                            reply_success: killSlackResult.replySuccess,
                            campaign_id: campaign.id,
                            campaign_name: campaign.name,
                            workspace_id: workspace.id,
                            workspace_name: workspace.name,
                            cm: cmName,
                            step: stepIndex,
                            variant: kill.variantIndex,
                            variant_label: VARIANT_LABELS[kill.variantIndex] ?? String(kill.variantIndex),
                            dry_run: isDryRun,
                          }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));

                          // Write dedup key (7-day TTL, cleared if variant is re-enabled by rescan)
                          await env.KV.put(killDedupKey, JSON.stringify({
                            campaignId: campaign.id,
                            stepIndex,
                            variantIndex: kill.variantIndex,
                            killedAt: new Date().toISOString(),
                          }), { expirationTtl: KILL_DEDUP_TTL_SECONDS }).catch(() => {});
                        } else {
                          console.log(
                            `[auto-turnoff] Kill dedup: already notified for ${campaign.name} step=${stepIndex + 1} variant=${kill.variantIndex} — skipping`,
                          );
                        }
                      } else {
                        console.error(
                          `[auto-turnoff] disableVariant returned false for ${campaign.name} step=${stepIndex} variant=${kill.variantIndex}`,
                        );
                        workspaceErrors++;
                        totalErrors++;
                      }
                    } catch (killErr) {
                      console.error(
                        `[auto-turnoff] Error disabling variant — campaign=${campaign.name} step=${stepIndex} variant=${kill.variantIndex}: ${killErr}`,
                      );
                      workspaceErrors++;
                      totalErrors++;
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
                  };

                  // Dedup: only notify once per blocked variant
                  const blockedDedupKey = `blocked:${campaign.id}:${stepIndex}:${blocked.variantIndex}`;
                  const alreadyBlocked = await env.KV.get(blockedDedupKey);

                  totalVariantsBlocked++;

                  if (!alreadyBlocked) {
                    const blockedTriggerRule =
                      opportunities === 0
                        ? `${sent} sent, 0 opportunities past ${threshold} sends`
                        : `Ratio ${ratioValue}:1 exceeds threshold ${threshold}:1`;

                    const blockedAudit: AuditEntry = {
                      timestamp: new Date().toISOString(),
                      action: 'BLOCKED',
                      workspace: workspace.name,
                      workspaceId: workspace.id,
                      campaign: campaign.name,
                      campaignId: campaign.id,
                      step: stepIndex,
                      variant: blocked.variantIndex,
                      variantLabel: VARIANT_LABELS[blocked.variantIndex] ?? String(blocked.variantIndex),
                      cm: cmName,
                      product: wsConfig.product,
                      trigger: { sent, opportunities, ratio: ratioValue, threshold, rule: blockedTriggerRule },
                      safety: { survivingVariants: 0, notification: 'LAST_VARIANT' },
                      dryRun: isDryRun,
                    };

                    await writeAuditLog(env.KV, blockedAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write audit log: ${err}`),
                    );
                    if (sb) writeAuditLogToSupabase(sb, blockedAudit).catch((err) =>
                      console.error(`[supabase] blocked audit write failed: ${err}`),
                    );

                    if (isDryRun) {
                      console.log(
                        `[DRY RUN] BLOCKED (last variant): ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${blocked.variantIndex} → channel=${channelId || 'FALLBACK'} cm=${cmName ?? 'unknown'}`,
                      );
                      console.log(
                        `[DRY RUN] Decision — sent=${sent} opportunities=${opportunities} ratio=${ratioValue} threshold=${threshold} — NOT killed, last active variant`,
                      );
                    } else {
                      const blockedSlackResult = await sendLastVariantNotification(blockedAction, channelId, env).catch((slackErr) => {
                        console.error(
                          `[auto-turnoff] Slack notification failed for blocked variant ${campaign.name} step=${stepIndex} variant=${blocked.variantIndex}: ${slackErr}`,
                        );
                        return { threadTs: null, replySuccess: false };
                      });
                      if (sb) writeNotificationToSupabase(sb, {
                        timestamp: new Date().toISOString(),
                        notification_type: 'LAST_VARIANT',
                        channel_id: channelId,
                        title: formatLastVariantTitle(blockedAction),
                        details: formatLastVariantDetails(blockedAction),
                        thread_ts: blockedSlackResult.threadTs,
                        reply_success: blockedSlackResult.replySuccess,
                        campaign_id: campaign.id,
                        campaign_name: campaign.name,
                        workspace_id: workspace.id,
                        workspace_name: workspace.name,
                        cm: cmName,
                        step: stepIndex,
                        variant: blocked.variantIndex,
                        variant_label: VARIANT_LABELS[blocked.variantIndex] ?? String(blocked.variantIndex),
                        dry_run: isDryRun,
                      }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));
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
                const warnings = checkVariantWarnings(stepDetail, stepAnalytics, stepIndex, threshold, killedIndices);

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
                      step: stepIndex,
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
                        rule: `${warning.pctConsumed}% of threshold consumed (${warning.sent}/${threshold} sends)`,
                      },
                      safety: { survivingVariants: -1, notification: null },
                      dryRun: isDryRun,
                    };

                    await writeAuditLog(env.KV, warningAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write warning audit log: ${err}`),
                    );
                    if (sb) writeAuditLogToSupabase(sb, warningAudit).catch((err) =>
                      console.error(`[supabase] warning audit write failed: ${err}`),
                    );

                    if (isDryRun) {
                      console.log(
                        `[DRY RUN] WARNING: ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${warning.variantIndex} — ${warning.pctConsumed}% consumed → channel=${channelId || 'FALLBACK'} cm=${cmName ?? 'unknown'}`,
                      );
                    } else {
                      const warningSlackResult = await sendWarningNotification(warning, campaign.name, workspace.name, stepIndex, channelId, env).catch((slackErr) => {
                        console.error(
                          `[auto-turnoff] Slack warning notification failed for ${campaign.name} step=${stepIndex} variant=${warning.variantIndex}: ${slackErr}`,
                        );
                        return { threadTs: null, replySuccess: false };
                      });
                      await env.KV.put(dedupKey, '1', { expirationTtl: WARNING_DEDUP_TTL_SECONDS });
                      if (sb) writeNotificationToSupabase(sb, {
                        timestamp: new Date().toISOString(),
                        notification_type: 'WARNING',
                        channel_id: channelId,
                        title: formatWarningTitle(warning, stepIndex),
                        details: formatWarningDetails(warning, campaign.name, workspace.name, stepIndex),
                        thread_ts: warningSlackResult.threadTs,
                        reply_success: warningSlackResult.replySuccess,
                        campaign_id: campaign.id,
                        campaign_name: campaign.name,
                        workspace_id: workspace.id,
                        workspace_name: workspace.name,
                        cm: cmName,
                        step: stepIndex,
                        variant: warning.variantIndex,
                        variant_label: warning.variantLabel,
                        dry_run: isDryRun,
                      }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));
                    }
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

          console.log(
            `[auto-turnoff] Workspace ${workspace.name} complete — kills=${workspaceKills} errors=${workspaceErrors}`,
          );
        } catch (wsErr) {
          console.error(
            `[auto-turnoff] Error processing workspace ${workspace.name} (${workspace.id}): ${wsErr}`,
          );
          totalErrors++;
        }
      }

      // 5. PHASE 2: RESCAN DISABLED VARIANTS FOR LATE-ARRIVING OPPORTUNITIES
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
              const freshAnalytics = await instantly.getStepAnalytics(entry.workspaceId, entry.campaignId);
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
              step: entry.stepIndex,
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
            if (sb) writeAuditLogToSupabase(sb, expiredAudit).catch((err) =>
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
            // Fetch fresh analytics
            const freshAnalytics = await instantly.getStepAnalytics(entry.workspaceId, entry.campaignId);
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

              // Verify variant is still disabled before re-enabling
              const campaignDetail = await instantly.getCampaignDetails(entry.workspaceId, entry.campaignId);
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
                  step: entry.stepIndex,
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
                if (sb) writeAuditLogToSupabase(sb, overrideAudit).catch((err) =>
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
                  const rescanSlackResult = await sendRescanNotification(entry, variantRow.opportunities, currentRatio, rescanChannelId, env).catch(
                    (err) => {
                      console.error(`[auto-turnoff] Rescan Slack notification failed: ${err}`);
                      return { threadTs: null, replySuccess: false };
                    },
                  );
                  if (sb) writeNotificationToSupabase(sb, {
                    timestamp: new Date().toISOString(),
                    notification_type: 'RESCAN_RE_ENABLED',
                    channel_id: rescanChannelId,
                    title: formatRescanTitle(entry),
                    details: formatRescanDetails(entry, variantRow.opportunities, currentRatio),
                    thread_ts: rescanSlackResult.threadTs,
                    reply_success: rescanSlackResult.replySuccess,
                    campaign_id: entry.campaignId,
                    campaign_name: entry.campaignName,
                    workspace_id: entry.workspaceId,
                    workspace_name: entry.workspaceName,
                    cm: entry.cmName,
                    step: entry.stepIndex,
                    variant: entry.variantIndex,
                    variant_label: entry.variantLabel,
                    dry_run: isDryRun,
                  }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));

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
                step: entry.stepIndex,
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
              if (sb) writeAuditLogToSupabase(sb, reEnableAudit).catch((err) =>
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
      try {
        if (leadsCheckCandidates.length > 0) {
          console.log(`[auto-turnoff] Leads check: evaluating ${leadsCheckCandidates.length} campaigns`);
        }

        for (const candidate of leadsCheckCandidates) {
          try {
            // Fetch lead counts (one new API call per campaign)
            const leadCounts = await instantly.countLeads(candidate.workspaceId, candidate.campaignId);
            const totalLeads = leadCounts.total_leads;
            const bounced = leadCounts.status.bounced;
            const skipped = leadCounts.status.skipped;

            // Compute uncontacted using step 0 sent (collected in Phase 1)
            const uncontacted = computeUncontacted(totalLeads, candidate.step0Sent, bounced, skipped);

            // Evaluate
            const result = evaluateLeadDepletion(uncontacted, candidate.dailyLimit, totalLeads);
            totalLeadsChecked++;

            if (result.status === 'SKIPPED') {
              continue;
            }

            if (result.status === 'EXHAUSTED') {
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
                  uncontacted: 0,
                  step0Sent: candidate.step0Sent,
                  bounced,
                  skipped,
                  dailyLimit: candidate.dailyLimit,
                },
                dryRun: isDryRun,
              };
              await env.KV.put(
                `log:${auditEntry.timestamp}:${candidate.campaignId}:leads`,
                JSON.stringify(auditEntry),
                { expirationTtl: 90 * 86400 },
              );
              if (sb) writeLeadsAuditToSupabase(sb, auditEntry).catch((err) =>
                console.error(`[supabase] leads_exhausted audit write failed: ${err}`),
              );

              // Send Slack notification
              const exhaustedSlackResult = await sendLeadsExhaustedNotification(
                candidate,
                totalLeads,
                candidate.channelId,
                env,
              ).catch((err) => {
                console.error(`[auto-turnoff] Leads exhausted Slack notification failed: ${err}`);
                return { threadTs: null, replySuccess: false };
              });
              if (sb) writeNotificationToSupabase(sb, {
                timestamp: new Date().toISOString(),
                notification_type: 'LEADS_EXHAUSTED',
                channel_id: candidate.channelId,
                title: formatLeadsExhaustedTitle(),
                details: formatLeadsExhaustedDetails(candidate, totalLeads),
                thread_ts: exhaustedSlackResult.threadTs,
                reply_success: exhaustedSlackResult.replySuccess,
                campaign_id: candidate.campaignId,
                campaign_name: candidate.campaignName,
                workspace_id: candidate.workspaceId,
                workspace_name: candidate.workspaceName,
                cm: candidate.cmName,
                step: null,
                variant: null,
                variant_label: null,
                dry_run: isDryRun,
              }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));

              // Clear any existing warning dedup (escalated to exhausted)
              await env.KV.delete(`leads-warning:${candidate.campaignId}`).catch(() => {});

            } else if (result.status === 'WARNING') {
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
                  uncontacted,
                  step0Sent: candidate.step0Sent,
                  bounced,
                  skipped,
                  dailyLimit: candidate.dailyLimit,
                },
                dryRun: isDryRun,
              };
              await env.KV.put(
                `log:${auditEntry.timestamp}:${candidate.campaignId}:leads`,
                JSON.stringify(auditEntry),
                { expirationTtl: 90 * 86400 },
              );
              if (sb) writeLeadsAuditToSupabase(sb, auditEntry).catch((err) =>
                console.error(`[supabase] leads_warning audit write failed: ${err}`),
              );

              // Send Slack notification
              const warningLeadsSlackResult = await sendLeadsWarningNotification(
                candidate,
                uncontacted,
                totalLeads,
                candidate.channelId,
                env,
              ).catch((err) => {
                console.error(`[auto-turnoff] Leads warning Slack notification failed: ${err}`);
                return { threadTs: null, replySuccess: false };
              });
              if (sb) writeNotificationToSupabase(sb, {
                timestamp: new Date().toISOString(),
                notification_type: 'LEADS_WARNING',
                channel_id: candidate.channelId,
                title: formatLeadsWarningTitle(),
                details: formatLeadsWarningDetails(candidate, uncontacted, totalLeads),
                thread_ts: warningLeadsSlackResult.threadTs,
                reply_success: warningLeadsSlackResult.replySuccess,
                campaign_id: candidate.campaignId,
                campaign_name: candidate.campaignName,
                workspace_id: candidate.workspaceId,
                workspace_name: candidate.workspaceName,
                cm: candidate.cmName,
                step: null,
                variant: null,
                variant_label: null,
                dry_run: isDryRun,
              }).catch((err) => console.error(`[supabase] notification write failed: ${err}`));

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
                    uncontacted,
                    step0Sent: candidate.step0Sent,
                    bounced,
                    skipped,
                    dailyLimit: candidate.dailyLimit,
                  },
                  dryRun: isDryRun,
                };
                await env.KV.put(
                  `log:${auditEntry.timestamp}:${candidate.campaignId}:leads`,
                  JSON.stringify(auditEntry),
                  { expirationTtl: 90 * 86400 },
                );
                if (sb) writeLeadsAuditToSupabase(sb, auditEntry).catch((err) =>
                  console.error(`[supabase] leads_recovered audit write failed: ${err}`),
                );

                await env.KV.delete(warningKey).catch(() => {});
                await env.KV.delete(exhaustedKey).catch(() => {});
              }
            }
          } catch (err) {
            console.error(
              `[auto-turnoff] Leads check error for "${candidate.campaignName}": ${err}`,
            );
          }
        }

        if (totalLeadsChecked > 0) {
          console.log(
            `[auto-turnoff] Leads check complete: checked=${totalLeadsChecked} warnings=${totalLeadsWarnings} exhausted=${totalLeadsExhausted} recovered=${totalLeadsRecovered}`,
          );
        }
      } catch (leadsPhaseErr) {
        console.error(`[auto-turnoff] Leads depletion phase error: ${leadsPhaseErr}`);
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
      if (sb) writeDailySnapshotToSupabase(sb, dailySnapshot).catch((err) =>
        console.error(`[supabase] daily snapshot write failed: ${err}`),
      );

      console.log(
        `[auto-turnoff] Snapshot: ${dailySnapshot.totalVariants} total, ${dailySnapshot.activeVariants} active, ${dailySnapshot.disabledVariants} disabled, ${dailySnapshot.aboveThreshold} above threshold`,
      );

      // 7. LOG RUN SUMMARY
      const durationMs = Date.now() - runStart;
      console.log(
        `[auto-turnoff] Run complete — workspaces=${totalWorkspaces} campaigns=${totalCampaignsEvaluated} killed=${totalVariantsKilled} deferred=${totalVariantsDeferred} blocked=${totalVariantsBlocked} warned=${totalVariantsWarned} rescan=${totalRescanChecked} reEnabled=${totalRescanReEnabled} expired=${totalExpired} cmOverride=${totalCmOverride} errors=${totalErrors} leads: checked=${totalLeadsChecked} warnings=${totalLeadsWarnings} exhausted=${totalLeadsExhausted} recovered=${totalLeadsRecovered} ${durationMs}ms`,
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
        leadsWarnings: totalLeadsWarnings,
        leadsExhausted: totalLeadsExhausted,
        leadsRecovered: totalLeadsRecovered,
        dryRun: isDryRun,
      };

      await writeRunSummary(env.KV, runSummary).catch((err) =>
        console.error(`[auto-turnoff] Failed to write run summary: ${err}`),
      );
      if (sb) writeRunSummaryToSupabase(sb, runSummary).catch((err) =>
        console.error(`[supabase] run summary write failed: ${err}`),
      );
    } finally {
      // 8. RELEASE LOCK
      await releaseLock(env.KV).catch((err) =>
        console.error(`[auto-turnoff] Failed to release lock: ${err}`),
      );

      // 9. CLOSE MCP
      await mcp.close().catch((err) =>
        console.error(`[auto-turnoff] Failed to close MCP client: ${err}`),
      );
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__scheduled') {
      await this.scheduled({ scheduledTime: Date.now(), cron: '0 * * * *' } as ScheduledEvent, env, ctx);
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

    return new Response('Auto Turn-Off Worker. Use /__scheduled to trigger manually, /__baseline to capture a baseline.', { status: 200 });
  },
};

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
