# Build Spec: Send Count Sanity Check + Kill Cap Fix

**Date:** 2026-03-20
**Priority:** URGENT (deploy before 6am ET / 10:00 UTC March 21)
**Codebase:** `builds/auto-turn-off/src/`
**Worker version:** `87d06fa` (current)

---

## Two bugs, one deploy

### Bug 1: Send Count Inflation

CC's `get_step_analytics` calls return inflated sent counts for some campaigns. The date filter fix (specced 2026-03-18) was never deployed — `instantly.ts` still passes no `start_date`/`end_date`. However, investigation confirmed that **date filters alone don't fix all campaigns** (New campaign 4 returned identical inflated numbers with and without date filters).

**Fix:** Deploy date filters (helps some campaigns) AND add a sanity check that skips campaigns with impossible data.

### Bug 2: Kill Cap Not Enforced

`MAX_KILLS_PER_RUN = 10` exists in config but Ido got 15 kills. The cap check at `index.ts:722` uses `totalVariantsKilled + pendingKills.length`. The issue: campaigns may be processed concurrently (the campaign loop uses a callback pattern at line 1095), so multiple campaigns can pass the cap check simultaneously before `totalVariantsKilled` is incremented by any batch execution. Classic race condition.

**Fix:** Process campaigns sequentially for kill evaluation, or use a shared pre-allocated kill budget.

---

## Files to change

| File | Changes | Lines |
|------|---------|-------|
| `src/instantly.ts` | Add `startDate?`/`endDate?` params to `getStepAnalytics()` | ~22-32 |
| `src/instantly-direct.ts` | Same date params for direct API path | ~115-127 |
| `src/types.ts` | Add `timestamp_created?: string` to `CampaignDetail` interface | find interface |
| `src/index.ts` | (1) Pass dates to getStepAnalytics, (2) Sanity check, (3) Kill cap fix | ~515, ~625, ~722 |

---

## Change 1: Date filter params on getStepAnalytics

### `src/instantly.ts` (lines 22-32)

Current:
```typescript
async getStepAnalytics(
  workspaceId: string,
  campaignId: string,
): Promise<StepAnalytics[]> {
  const raw = await this.mcp.callTool<unknown>('get_step_analytics', {
    workspace_id: workspaceId,
    campaign_id: campaignId,
    include_opportunities: true,
  });
```

Change to:
```typescript
async getStepAnalytics(
  workspaceId: string,
  campaignId: string,
  startDate?: string,
  endDate?: string,
): Promise<StepAnalytics[]> {
  const params: Record<string, unknown> = {
    workspace_id: workspaceId,
    campaign_id: campaignId,
    include_opportunities: true,
  };
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  const raw = await this.mcp.callTool<unknown>('get_step_analytics', params);
```

### `src/instantly-direct.ts` (~lines 115-127)

Apply the same pattern: add optional `startDate`/`endDate` params, include `start_date`/`end_date` in the REST API query params when present.

### `src/types.ts`

Add to the `CampaignDetail` interface:
```typescript
timestamp_created?: string;
```

---

## Change 2: Sanity check in index.ts

After fetching step analytics and before evaluating kills, add a cross-validation. Insert this BEFORE the `anyAboveThreshold` check (~line 625):

```typescript
// Sanity check: Step 1 total sent should not exceed campaign contacted count.
// The Instantly API sometimes returns inflated step analytics.
const step1Analytics = allAnalytics.filter(a => parseInt(a.step, 10) === 0);
const step1TotalSent = step1Analytics.reduce((sum, a) => sum + a.sent, 0);
const campaignAnalytics = await instantly.getCampaignAnalytics(workspace.id, campaign.id);
const contactedCount = campaignAnalytics.contacted;

if (contactedCount > 0 && step1TotalSent > contactedCount * 1.1) {
  // Allow 10% tolerance for timing differences, but flag anything beyond that
  console.warn(
    `[auto-turnoff] DATA INTEGRITY SKIP: "${campaign.name}" Step 1 sent (${step1TotalSent}) exceeds contacted (${contactedCount}) by ${Math.round((step1TotalSent / contactedCount - 1) * 100)}%. Skipping kill evaluation — data unreliable.`,
  );
  // Still process warnings and leads, just skip kills
  continue; // or return; depending on loop type
}
```

**Important:** This is a SKIP, not a kill. Campaigns with bad data are deferred to next run. They'll be re-checked every run until the data resolves or Instantly fixes their API.

**Note on the extra API call:** `getCampaignAnalytics` adds 1 call per campaign. This is acceptable — it's a lightweight endpoint and we're running 3x/day, not hourly. If performance is a concern, only call it for campaigns where step analytics look suspicious (e.g., only when step 1 total > some absolute threshold like 50k).

---

## Change 3: Kill cap — global budget counter

The fix: track a global `killBudgetRemaining` counter that decrements as kills are **queued** (not just executed). This prevents the race condition where concurrent campaign processing can exceed the cap.

### In `index.ts`, before the campaign loop (~line 400ish, find where `totalVariantsKilled` is declared):

```typescript
let killBudgetRemaining = MAX_KILLS_PER_RUN > 0 ? MAX_KILLS_PER_RUN : Infinity;
```

### Replace the kill cap check at line 722:

Current:
```typescript
const killCapReached = MAX_KILLS_PER_RUN > 0 && (totalVariantsKilled + pendingKills.length) >= MAX_KILLS_PER_RUN;
```

New:
```typescript
const killCapReached = killBudgetRemaining <= 0;
```

### After adding to pendingKills (line 780-785), decrement the budget:

Current:
```typescript
pendingKills.push({
  kill: killAction,
  auditEntry,
  stepIndex,
  channelId,
});
```

New:
```typescript
pendingKills.push({
  kill: killAction,
  auditEntry,
  stepIndex,
  channelId,
});
killBudgetRemaining--;
```

### If batch execution fails (line 1080-1086), restore the budget:

In the catch block, add:
```typescript
killBudgetRemaining += pendingKills.length;
```

This ensures: if 3 campaigns each try to queue 5 kills, only the first 10 across all of them get through. The counter is decremented at queue time (before execution), so even concurrent processing can't exceed it.

**Also:** If the current campaign loop is concurrent (`Promise.all`), consider switching to sequential processing (`for...of` with `await`). The kill budget counter only works reliably with sequential processing unless you add a mutex. Check the loop structure and make the call.

---

## Change 4: Pass dates to getStepAnalytics call in index.ts

Find where `getStepAnalytics` is called (~line 515). Currently:
```typescript
const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id);
```

Change to:
```typescript
// Use campaign creation date as start_date for accurate step analytics
const createdDate = (campaignDetail as Record<string, unknown>).timestamp_created as string | undefined;
const startDate = createdDate ? createdDate.split('T')[0] : undefined;
const endDate = new Date().toISOString().split('T')[0];
const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id, startDate, endDate);
```

Also update the comment on line 514 — remove "unfiltered — validated as accurate" (it's factually wrong).

---

## DO NOT change

- `evaluator.ts` — kill logic is correct, don't touch it
- `slack.ts` — notification format is fine
- `router.ts` — routing is correct
- `config.ts` — MAX_KILLS_PER_RUN = 10 is correct
- `leads-monitor.ts` — leads monitoring is 100% accurate

---

## Execution Instructions

1. `/technical` to load codebase
2. Read `src/instantly.ts`, `src/instantly-direct.ts`, `src/types.ts`, `src/index.ts`
3. Implement all 4 changes
4. Run `tsc --noEmit` to verify
5. `/cc-review` loop until approved
6. Deploy: `cd builds/auto-turn-off && ./deploy.sh`
7. After deploy: verify `src/version.ts` has new git hash, check Supabase for new worker_version, add to VERSION_REGISTRY.md
8. Write handoff doc to `builds/auto-turn-off/specs/` with date prefix

---

## Verification

After deploy, the next run should show:
- [ ] Any campaigns with inflated data log `DATA INTEGRITY SKIP` in console
- [ ] Kill count in `run_summaries.variants_disabled` <= 10
- [ ] Date-filtered step analytics match for clean campaigns (Carlos, most Alex)
- [ ] No premature kills on Alex Construction E/F (2,608 actual sends, well below 3,800)
