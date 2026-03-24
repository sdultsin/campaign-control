# Scale Winners - Build Spec

**Date:** 2026-03-23
**Source TDD:** `specs/2026-03-23-scale-winners-tdd.md`
**Status:** IMPLEMENTED - all 6 review fixes applied

---

## Required Reading

1. `src/types.ts` - All type definitions (DashboardItemType, AuditEntry, RunSummary, etc.)
2. `src/config.ts` - Thresholds, workspace configs, dedup TTLs, PILOT_CMS
3. `src/evaluator.ts` - Current kill evaluation logic (evaluateVariant, evaluateStep)
4. `src/slack.ts` - NotificationCollector pattern, format functions, SlackNotificationType, morning digest
5. `src/dashboard-state.ts` - buildDashboardState(), DetectedIssue shape
6. `src/supabase.ts` - upsertDashboardItem, resolveStaleItems, getDashboardDigestData, writeAuditLogToSupabase
7. `src/index.ts` - Main loop (Phase 1 campaign evaluation, Phase 5 dashboard build, notification flush, morning digest, run summary)
8. `src/thresholds.ts` - resolveThreshold, OFF_CAMPAIGN_BUFFER application
9. `src/router.ts` - resolveChannel, resolveCmName, isPilotCampaign

## Load Order

1. Read types.ts and config.ts (foundations)
2. Read evaluator.ts (add evaluateWinner function)
3. Read slack.ts (add WINNER notification type and formatters)
4. Read dashboard-state.ts (add WINNING items to dashboard state builder)
5. Read supabase.ts (update getDashboardDigestData for winners)
6. Read index.ts (wire winner detection into Phase 1, add Phase 5 winners, morning digest, run summary)

---

## Implementation

### Step 1: Add winner thresholds to config.ts

**File:** `src/config.ts`

Add winner threshold multiplier constant after `OPP_RUNWAY_MULTIPLIER` (line 44):

```typescript
/** Winner threshold = kill threshold * WINNER_THRESHOLD_MULTIPLIER (0.66x). */
export const WINNER_THRESHOLD_MULTIPLIER = 0.66;

/** Minimum opportunities required to qualify as a winner. Eliminates single-opp flukes. */
export const WINNER_MIN_OPPS = 2;

/** Minimum sends = kill_threshold * WINNER_MIN_SENDS_MULTIPLIER. Variant must have been in market long enough. */
export const WINNER_MIN_SENDS_MULTIPLIER = 0.5;
```

These constants derive winner thresholds at runtime:
- Google: 3,800 * 0.66 = 2,508 -> 2,508 (TDD says 2,500 - use the multiplier, close enough)
- SMTP/OTD: 4,500 * 0.66 = 2,970 (TDD says 3,000)
- Outlook: 5,000 * 0.66 = 3,300 (matches TDD)

Note: The TDD uses rounded values. The multiplier produces nearly identical results. OFF campaigns already apply `OFF_CAMPAIGN_BUFFER` (1.2x) to the kill threshold, so the winner threshold inherits that: `(kill_threshold * 1.2) * 0.66`.

### Step 2: Add winner types to types.ts

**File:** `src/types.ts`

**2a.** Extend `DashboardItemType` union (line 329):

```typescript
export type DashboardItemType = 'BLOCKED' | 'DISABLED' | 'LEADS_EXHAUSTED' | 'LEADS_WARNING' | 'WINNING';
```

**2b.** Extend `DashboardSeverity` union (line 330):

```typescript
export type DashboardSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
```

**2c.** Add `WINNER_DETECTED` to `AuditEntry.action` union (line 213):

```typescript
action: 'DISABLED' | 'BLOCKED' | 'WARNING' | 'RE_ENABLED' | 'EXPIRED' | 'CM_OVERRIDE' | 'DEFERRED' | 'MANUAL_REVERT' | 'GHOST_REENABLE' | 'WINNER_DETECTED';
```

**2d.** Add `winnersDetected: number` to `RunSummary` (after `ghostReEnables`, line 256):

```typescript
winnersDetected: number;
```

**2e.** Add `WinnerEntry` interface (new, after `RescanEntry`):

```typescript
export interface WinnerEntry {
  campaignId: string;
  campaignName: string;
  workspaceId: string;
  workspaceName: string;
  stepIndex: number;
  variantIndex: number;
  variantLabel: string;
  sent: number;
  opportunities: number;
  ratio: number;
  winnerThreshold: number;
  killThreshold: number;
  cm: string | null;
  product: Product;
  isOff: boolean;
}
```

### Step 3: Add evaluateWinner function to evaluator.ts

**File:** `src/evaluator.ts`

Add imports at top:

```typescript
import { WINNER_THRESHOLD_MULTIPLIER, WINNER_MIN_OPPS, WINNER_MIN_SENDS_MULTIPLIER } from './config';
```

Add new function after `checkVariantWarnings`:

```typescript
export interface WinnerResult {
  isWinner: boolean;
  reason: string;
  ratio?: number;
  winnerThreshold?: number;
}

/**
 * Evaluate a single variant for winner status.
 * Winner = ratio <= (kill_threshold * 0.66), with guardrails on min sends and min opps.
 * The threshold parameter is the KILL threshold (already adjusted for OFF campaigns).
 */
export function evaluateWinner(
  sent: number,
  opportunities: number,
  killThreshold: number,
): WinnerResult {
  const minSends = killThreshold * WINNER_MIN_SENDS_MULTIPLIER;
  if (sent < minSends) {
    return { isWinner: false, reason: `Insufficient sends (${sent} < ${Math.round(minSends)})` };
  }
  if (opportunities < WINNER_MIN_OPPS) {
    return { isWinner: false, reason: `Insufficient opportunities (${opportunities} < ${WINNER_MIN_OPPS})` };
  }
  const ratio = sent / opportunities;
  const winnerThreshold = killThreshold * WINNER_THRESHOLD_MULTIPLIER;
  if (ratio <= winnerThreshold) {
    return { isWinner: true, reason: `Ratio ${ratio.toFixed(1)}:1 <= winner threshold ${winnerThreshold.toFixed(0)}:1`, ratio, winnerThreshold };
  }
  return { isWinner: false, reason: `Ratio ${ratio.toFixed(1)}:1 > winner threshold ${winnerThreshold.toFixed(0)}:1` };
}
```

Key design notes:
- Winner and kill ranges are non-overlapping. A variant with ratio > kill_threshold is a kill candidate. A variant with ratio <= kill_threshold * 0.66 is a winner. The gap (0.66x to 1.0x of kill_threshold) is neutral territory.
- The `killThreshold` parameter already has OFF buffer applied (via `resolveThreshold`), so the winner threshold inherits it automatically.

### Step 4: Add WINNER Slack notification type and formatters to slack.ts

**File:** `src/slack.ts`

**4a.** Add `'WINNER'` to `SlackNotificationType` union (line 14):

```typescript
export type SlackNotificationType =
  | 'KILL'
  | 'LAST_VARIANT'
  | 'WARNING'
  | 'RESCAN_RE_ENABLED'
  | 'LEADS_EXHAUSTED'
  | 'LEADS_WARNING'
  | 'WINNER';
```

**4b.** Add to `GROUP_TITLES` (line 22):

```typescript
WINNER: (n) => `:trophy: Winning Variants Detected (${n})`,
```

**4c.** Add format functions (after `formatLeadsExhaustedDetails`):

```typescript
export function formatWinnerDetails(
  workspaceName: string,
  campaignName: string,
  stepIndex: number,
  variantLabel: string,
  sent: number,
  opportunities: number,
  ratio: number,
  winnerThreshold: number,
  isOff: boolean,
  leadsNote: string | null,
): string {
  const improvement = Math.round(winnerThreshold / ratio);
  let message = `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${variantLabel} - WINNING

Emails sent: ${sent.toLocaleString()}
Opportunities: ${opportunities}
Ratio: ${ratio.toFixed(0)}:1 (threshold: ${winnerThreshold.toFixed(0)}:1 - ${improvement}x better)`;

  if (isOff) {
    message += formatOffAnnotation(Math.round(winnerThreshold / WINNER_THRESHOLD_MULTIPLIER));
  }

  if (leadsNote) {
    message += `\n\n${leadsNote}`;
  }

  return message;
}

export function formatAllVariantsWinning(stepIndex: number): string {
  return `All variants in Step ${stepIndex + 1} are performing well. Add more leads to this campaign.`;
}

export function formatCampaignWinnerRollup(campaignName: string, steps: number[]): string {
  const stepList = steps.map(s => s + 1).join(' and ');
  return `Campaign ${campaignName} has winning variants in Steps ${stepList}. Strong candidate for increased volume.`;
}
```

Import `WINNER_THRESHOLD_MULTIPLIER` at the top of slack.ts:

```typescript
import { VARIANT_LABELS, OFF_CAMPAIGN_BUFFER, WINNER_THRESHOLD_MULTIPLIER } from './config';
```

**4d.** Update `sendMorningDigest` signature and body to include winners:

Add `winnersLast24h` parameter and append to digest text:

```typescript
export async function sendMorningDigest(
  channel: string,
  cm: string,
  dashboardUrl: string,
  summary: { activeCount: number; criticalCount: number; killsSince: number; reEnablesSince: number; winnersLast24h: Array<{ campaignName: string; variantLabel: string; ratio: string }> },
  token: string,
  isDryRun: boolean,
): Promise<void> {
```

After the existing text, before the dry-run check, append winners:

```typescript
  let winnersLine = '';
  if (summary.winnersLast24h.length > 0) {
    const topPerformers = summary.winnersLast24h
      .slice(0, 5)
      .map(w => `[${w.campaignName}] Variant ${w.variantLabel} (${w.ratio})`)
      .join(', ');
    winnersLine = `\nTop performers (last 24h): ${topPerformers}`;
  }
```

Insert `${winnersLine}` into the text template after the status line.

### Step 5: Wire winner detection into index.ts Phase 1

**File:** `src/index.ts`

**5a.** Add imports:

```typescript
import { evaluateStep, evaluateVariant, checkVariantWarnings, evaluateWinner } from './evaluator';
import {
  NotificationCollector,
  formatKillDetails, formatLastVariantDetails,
  formatWarningDetails, formatRescanDetails,
  formatLeadsWarningDetails, formatLeadsExhaustedDetails,
  formatWinnerDetails, formatAllVariantsWinning, formatCampaignWinnerRollup,
  sendMorningDigest,
} from './slack';
import { WINNER_THRESHOLD_MULTIPLIER } from './config';
import type { WinnerEntry } from './types';
```

**5b.** Add winner counter and collection arrays (after `totalLeadsRecovered` declaration, around line 482):

```typescript
// Winner detection
let totalWinnersDetected = 0;
const dashboardWinners: WinnerEntry[] = [];
```

**5c.** Add winner evaluation INSIDE the Phase 1 per-campaign loop, AFTER the warning check (after the `}` closing the step loop at ~line 1081, before `// --- BATCH KILL EXECUTION ---`).

This is a new block inside the `for (let stepIndex ...)` loop, after the warning block:

```typescript
                // --- WINNER DETECTION ---
                // Evaluate active variants that are NOT kill candidates for winner status.
                // Uses the same analytics and threshold already resolved — zero extra API calls.
                for (let vi = 0; vi < stepDetail.variants.length; vi++) {
                  if (stepDetail.variants[vi].v_disabled) continue;
                  // Skip variants that are kill candidates or already killed
                  if (kills.some(k => k.variantIndex === vi)) continue;
                  if (blocked && blocked.variantIndex === vi) continue;

                  const variantAnalytics = stepAnalytics.find(
                    (a) => parseInt(a.variant, 10) === vi,
                  );
                  if (!variantAnalytics) continue;

                  const winnerResult = evaluateWinner(variantAnalytics.sent, variantAnalytics.opportunities, threshold);
                  if (!winnerResult.isWinner) continue;

                  // Permanent dedup: check KV flag (no TTL)
                  const winnerDedupKey = `winner:notified:${campaign.id}:${stepIndex}:${vi}`;
                  const alreadyNotified = await env.KV.get(winnerDedupKey);

                  const variantLabel = VARIANT_LABELS[vi] ?? String(vi);
                  const winnerEntry: WinnerEntry = {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                    stepIndex,
                    variantIndex: vi,
                    variantLabel,
                    sent: variantAnalytics.sent,
                    opportunities: variantAnalytics.opportunities,
                    ratio: winnerResult.ratio!,
                    winnerThreshold: winnerResult.winnerThreshold!,
                    killThreshold: threshold,
                    cm: cmName,
                    product: wsConfig.product,
                    isOff: isOffCampaign(campaign.name),
                  };

                  // Always collect for dashboard (dashboard re-evaluates every scan)
                  dashboardWinners.push(winnerEntry);

                  if (!alreadyNotified) {
                    totalWinnersDetected++;

                    // Check for leads-exhausted cross-reference
                    let leadsNote: string | null = null;
                    const leadsExhKey = `leads-exhausted:${campaign.id}`;
                    const leadsWarnKey = `leads-warning:${campaign.id}`;
                    const hasLeadsExhausted = await env.KV.get(leadsExhKey);
                    const hasLeadsWarning = await env.KV.get(leadsWarnKey);
                    if (hasLeadsExhausted || hasLeadsWarning) {
                      leadsNote = 'Note: This campaign is low on leads. Add more leads - this is a well-performing campaign.';
                    }

                    // Write audit log
                    const winnerAudit: AuditEntry = {
                      timestamp: new Date().toISOString(),
                      action: 'WINNER_DETECTED',
                      workspace: workspace.name,
                      workspaceId: workspace.id,
                      campaign: campaign.name,
                      campaignId: campaign.id,
                      step: stepIndex + 1,
                      variant: vi,
                      variantLabel,
                      cm: cmName,
                      product: wsConfig.product,
                      trigger: {
                        sent: variantAnalytics.sent,
                        opportunities: variantAnalytics.opportunities,
                        ratio: winnerResult.ratio!.toFixed(1),
                        threshold,
                        effective_threshold: winnerResult.winnerThreshold!,
                        rule: `Winner: ratio ${winnerResult.ratio!.toFixed(1)}:1 <= winner threshold ${winnerResult.winnerThreshold!.toFixed(0)}:1`,
                      },
                      safety: { survivingVariants: -1, notification: null },
                      dryRun: isDryRun,
                    };

                    await writeAuditLog(env.KV, winnerAudit).catch((err) =>
                      console.error(`[auto-turnoff] Failed to write winner audit log: ${err}`),
                    );
                    if (sb) await writeAuditLogToSupabase(sb, winnerAudit).catch((err) =>
                      console.error(`[supabase] winner audit write failed: ${err}`),
                    );

                    // Collect Slack notification
                    if (!isDryRun) {
                      collector.add(channelId, 'WINNER', formatWinnerDetails(
                        workspace.name,
                        campaign.name,
                        stepIndex,
                        variantLabel,
                        variantAnalytics.sent,
                        variantAnalytics.opportunities,
                        winnerResult.ratio!,
                        winnerResult.winnerThreshold!,
                        isOffCampaign(campaign.name),
                        leadsNote,
                      ), {
                        timestamp: new Date().toISOString(),
                        notification_type: 'WINNER',
                        campaign_id: campaign.id,
                        campaign_name: campaign.name,
                        workspace_id: workspace.id,
                        workspace_name: workspace.name,
                        cm: cmName,
                        step: stepIndex + 1,
                        variant: vi,
                        variant_label: variantLabel,
                        dry_run: isDryRun,
                      });
                    } else {
                      console.log(
                        `[DRY RUN] WINNER: ${workspace.name} / ${campaign.name} / Step ${stepIndex + 1} Variant ${variantLabel} — ratio=${winnerResult.ratio!.toFixed(1)} threshold=${winnerResult.winnerThreshold!.toFixed(0)}`,
                      );
                    }

                    // Set permanent dedup flag (no TTL = forever)
                    await env.KV.put(winnerDedupKey, JSON.stringify({
                      campaignId: campaign.id,
                      stepIndex,
                      variantIndex: vi,
                      detectedAt: new Date().toISOString(),
                    })).catch(() => {});
                  }
                }
```

**5d.** Add roll-up notifications AFTER Phase 1 completes (after the workspace loop closes, before Phase 2 rescan, around line 1240).

Insert a new block:

```typescript
      // --- WINNER ROLL-UPS ---
      if (dashboardWinners.length > 0 && !isDryRun) {
        // All-variants-winning per step (3+ winners in same step)
        const byStep = new Map<string, WinnerEntry[]>();
        for (const w of dashboardWinners) {
          const key = `${w.campaignId}:${w.stepIndex}`;
          if (!byStep.has(key)) byStep.set(key, []);
          byStep.get(key)!.push(w);
        }
        for (const [_key, winners] of byStep) {
          if (winners.length >= 3) {
            const channelId = resolveChannel(winners[0].cm, env.SLACK_FALLBACK_CHANNEL);
            collector.add(channelId, 'WINNER', formatAllVariantsWinning(winners[0].stepIndex), {
              timestamp: new Date().toISOString(),
              notification_type: 'WINNER',
              campaign_id: winners[0].campaignId,
              campaign_name: winners[0].campaignName,
              workspace_id: winners[0].workspaceId,
              workspace_name: winners[0].workspaceName,
              cm: winners[0].cm,
              step: winners[0].stepIndex + 1,
              variant: null,
              variant_label: null,
              dry_run: isDryRun,
            });
          }
        }

        // Campaign-level winner roll-up (2+ steps with winners in same campaign)
        const byCampaign = new Map<string, Set<number>>();
        for (const w of dashboardWinners) {
          if (!byCampaign.has(w.campaignId)) byCampaign.set(w.campaignId, new Set());
          byCampaign.get(w.campaignId)!.add(w.stepIndex);
        }
        for (const [campaignId, steps] of byCampaign) {
          if (steps.size >= 2) {
            const firstWinner = dashboardWinners.find(w => w.campaignId === campaignId)!;
            const channelId = resolveChannel(firstWinner.cm, env.SLACK_FALLBACK_CHANNEL);
            collector.add(channelId, 'WINNER', formatCampaignWinnerRollup(firstWinner.campaignName, Array.from(steps)), {
              timestamp: new Date().toISOString(),
              notification_type: 'WINNER',
              campaign_id: campaignId,
              campaign_name: firstWinner.campaignName,
              workspace_id: firstWinner.workspaceId,
              workspace_name: firstWinner.workspaceName,
              cm: firstWinner.cm,
              step: null,
              variant: null,
              variant_label: null,
              dry_run: isDryRun,
            });
          }
        }
      }
```

### Step 6: Add WINNING items to dashboard-state.ts

**File:** `src/dashboard-state.ts`

**6a.** Import `WinnerEntry` type:

```typescript
import type { AuditEntry, LeadsAuditEntry, DashboardItemType, DashboardSeverity, WinnerEntry } from './types';
```

**6b.** Add `winners: WinnerEntry[]` parameter to `buildDashboardState`:

```typescript
export async function buildDashboardState(
  sb: SupabaseClient,
  scanTimestamp: string,
  blockedActions: AuditEntry[],
  leadsExhausted: LeadsAuditEntry[],
  leadsWarnings: LeadsAuditEntry[],
  dryRunKills: AuditEntry[] = [],
  winners: WinnerEntry[] = [],
): Promise<{ upserted: number; resolved: number }> {
```

**6c.** Add winner processing block (after LEADS_WARNING block, before upsert loop):

```typescript
  // WINNING -> INFO dashboard items
  for (const entry of winners) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'WINNING',
      severity: 'INFO',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaignName,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspaceName,
      step: entry.stepIndex + 1,
      variant: entry.variantIndex,
      variant_label: entry.variantLabel,
      context: {
        sent: entry.sent,
        opportunities: entry.opportunities,
        ratio: entry.ratio,
        winner_threshold: entry.winnerThreshold,
        kill_threshold: entry.killThreshold,
        is_off: entry.isOff,
      },
    });
  }
```

### Step 7: Wire winners into Phase 5 dashboard state call in index.ts

**File:** `src/index.ts`

Update the `buildDashboardState` call (around line 2021) to pass winners:

```typescript
          const dashResult = await buildDashboardState(
            sb,
            new Date().toISOString(),
            dashboardBlocked,
            dashboardLeadsExhausted,
            dashboardLeadsWarnings,
            dashboardDryRunKills,
            dashboardWinners,
          );
```

### Step 8: Update morning digest to include winners

**File:** `src/supabase.ts`

Update `getDashboardDigestData` to query for winners in the last 24h:

```typescript
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
```

Add after `reEnablesSince` query:

```typescript
  // Winners detected in last 24h (for digest top performers line)
  const { data: winnerRows } = await sb
    .from('audit_logs')
    .select('campaign, variant_label, trigger_ratio')
    .eq('cm', cm)
    .eq('action', 'WINNER_DETECTED')
    .gte('timestamp', yesterday)
    .not('worker_version', 'is', null)
    .order('trigger_ratio', { ascending: true })
    .limit(10);

  const winnersLast24h = (winnerRows ?? []).map(row => ({
    campaignName: row.campaign as string,
    variantLabel: row.variant_label as string,
    ratio: `${row.trigger_ratio}:1`,
  }));
```

Return:

```typescript
  return {
    activeCount: activeCount ?? 0,
    criticalCount: criticalCount ?? 0,
    killsSince: killsSince ?? 0,
    reEnablesSince: reEnablesSince ?? 0,
    winnersLast24h,
  };
```

### Step 9: Update RunSummary in index.ts

**File:** `src/index.ts`

Add `winnersDetected: totalWinnersDetected` to the RunSummary object (around line 2127):

```typescript
      const runSummary: RunSummary = {
        // ... existing fields ...
        ghostReEnables: ghostCount,
        winnersDetected: totalWinnersDetected,
        dryRun: isDryRun,
      };
```

Update the run complete log line to include winners:

```
killed=${totalVariantsKilled} ... ghostReEnables=${ghostCount} winners=${totalWinnersDetected} ${durationMs}ms
```

### Step 10: Update run summary Supabase write

**File:** `src/supabase.ts`

Add `winners_detected` to the `writeRunSummaryToSupabase` insert object:

```typescript
    winners_detected: summary.winnersDetected,
```

This requires adding the column to the `run_summaries` table. A Supabase migration or manual ALTER TABLE:

```sql
ALTER TABLE run_summaries ADD COLUMN IF NOT EXISTS winners_detected integer DEFAULT 0;
```

---

## Files Modified (Summary)

| File | Changes |
|------|---------|
| `src/config.ts` | Add `WINNER_THRESHOLD_MULTIPLIER`, `WINNER_MIN_OPPS`, `WINNER_MIN_SENDS_MULTIPLIER` constants |
| `src/types.ts` | Extend `DashboardItemType` (+WINNING), `DashboardSeverity` (+INFO), `AuditEntry.action` (+WINNER_DETECTED), `RunSummary` (+winnersDetected), add `WinnerEntry` interface |
| `src/evaluator.ts` | Add `evaluateWinner()` function + `WinnerResult` interface |
| `src/slack.ts` | Add `WINNER` to `SlackNotificationType`, `GROUP_TITLES`, `formatWinnerDetails()`, `formatAllVariantsWinning()`, `formatCampaignWinnerRollup()`. Update `sendMorningDigest()` signature + body. |
| `src/dashboard-state.ts` | Add `winners` parameter to `buildDashboardState()`, process WINNING -> INFO dashboard items |
| `src/supabase.ts` | Update `getDashboardDigestData()` to query WINNER_DETECTED audit logs. Add `winners_detected` to run summary write. |
| `src/index.ts` | Add winner evaluation in Phase 1 step loop, add roll-up notifications after Phase 1, pass winners to Phase 5 dashboard state, update RunSummary, update log line. |

## No New Files

All changes are modifications to existing files. No new source files required.

## Database Migration

One column addition:

```sql
ALTER TABLE run_summaries ADD COLUMN IF NOT EXISTS winners_detected integer DEFAULT 0;
```

No new tables. The `dashboard_items` table already supports arbitrary `item_type` values (text column). The `audit_logs` table already supports arbitrary `action` values.

## What Does NOT Change

- Kill evaluation logic (evaluateVariant, evaluateStep) - untouched
- Rescan/redemption window logic - untouched
- Leads depletion monitor - untouched (but cross-referenced by winner detection)
- Kill persistence monitor - untouched
- Dashboard frontend - separate deployment (reads from Supabase, no worker changes needed beyond new item_type)
- No writes to Instantly API - winners are informational only

## Key Design Decisions

1. **Zero extra API calls.** Winner detection uses the same `allAnalytics` and `threshold` already fetched in Phase 1. No additional Instantly API calls.

2. **Permanent Slack dedup.** KV key `winner:notified:{campaignId}:{step}:{variant}` with NO TTL. One notification per variant, ever. CM "Done" dismiss uses dashboard_items `dismissed_at` column (already exists).

3. **Dashboard auto-resolve.** WINNING items are only upserted if the variant still meets criteria on the current scan. If it doesn't, `resolveStaleItems()` (already implemented in supabase.ts) auto-resolves it. No special winner degradation logic needed.

4. **Sort order.** The dashboard frontend sorts by severity. CRITICAL > WARNING > INFO means winners (INFO) naturally sort below all action items. No worker change needed.

5. **OFF campaign buffer.** Winner threshold inherits the OFF buffer because `resolveThreshold()` already applies `OFF_CAMPAIGN_BUFFER` to the kill threshold. `evaluateWinner()` multiplies by `WINNER_THRESHOLD_MULTIPLIER` (0.66), producing: `base_threshold * 1.2 * 0.66`. This matches TDD section 1: "Apply the existing 1.2x buffer to the winner threshold."

---

## Verification

1. `tsc` - clean compile
2. Trigger manual run via `/__scheduled`
3. Check console logs for `WINNER:` entries
4. Verify audit_logs in Supabase: `SELECT * FROM audit_logs WHERE action = 'WINNER_DETECTED' ORDER BY timestamp DESC LIMIT 10;`
5. Verify dashboard_items: `SELECT * FROM dashboard_items WHERE item_type = 'WINNING' AND resolved_at IS NULL;`
6. Verify Slack: winner notifications appear in CM channels with correct format
7. Verify dedup: second run should NOT re-notify same variants
8. Verify auto-resolve: if a winner's ratio drifts above threshold, dashboard item should resolve on next scan

---

## Execution Instructions

1. `/technical` - implement all changes from this spec
2. `tsc` - confirm clean compile
3. `/cc-review` - adversarial review loop until approved
4. Deploy via `./deploy.sh`
5. Verify: trigger manual run, confirm winner notifications appear for known high-performing variants
6. Handoff doc to `specs/` with deployment hash and verification results
