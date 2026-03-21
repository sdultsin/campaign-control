# Build Spec: Remove Date Filter from Main Evaluation Path

**Date:** 2026-03-21
**Priority:** URGENT (deploy before next cron run)
**Codebase:** `builds/auto-turn-off/src/`
**Worker version (broken):** `0d78ca0`

---

## Bug Summary

The 8am ET run on 2026-03-21 produced 5 incorrect kills out of 11 total. All 5 had undercounted opportunities because the main evaluation path passes `start_date`/`end_date` to `getStepAnalytics()`. The Instantly API's date-filtered response drops opportunities it can't attribute within the date window, while sent counts survive the filter.

### Impact

| Campaign | Step | Var | CC Opps | UI Opps | Impact |
|---|---|---|---|---|---|
| RG2161 Construction | 3 | A | 2 | 9 | Killed a healthy variant |
| RG2161 Construction | 4 | A | 2 | 19 | Killed the BEST performer in step |
| RG2161 Construction | 5 | B | 0 | 4 | Killed a healthy variant (also had empty body) |
| Restaurants RG2157-2160 | 1 | B | 3 | 6 | Killed a below-threshold variant |
| Summit Bridge Construction | 3 | C | 1 | 2 | Killed a below-threshold variant |

The 6 correct kills all had 0 UI opps -- confirming the date filter is the sole cause (you can't undercount 0).

### Root Cause

This was a **known bug**, identified on 2026-03-18 (see `bugs/2026-03-18-summit-bridge-false-positive.md`). The resolution (`specs/v2-data-accuracy-resolution.md`) concluded:

> "Date-filtered calls break both sent and opp accuracy -- do not use them."

The date filter was re-introduced on 2026-03-20 in the send-accuracy-and-kill-cap spec to address sent count inflation on older campaigns. But the sanity check at lines 628-640 (Step 1 sent vs contacted count, 10% tolerance) already handles that problem -- making the date filter redundant safety.

---

## The Fix

Remove the date filter parameters from the main evaluation `getStepAnalytics()` call in `index.ts`. The rescan phase (line 1248) already uses unfiltered calls with the comment "Fetch fresh analytics (unfiltered -- validated as accurate)". The main path should match.

### File: `src/index.ts`

**Lines 515-519 -- BEFORE:**

```typescript
// b. Get step analytics (date-filtered for accuracy)
const createdDate = (campaignDetail as Record<string, unknown>).timestamp_created as string | undefined;
const startDate = createdDate ? createdDate.split('T')[0] : undefined;
const endDate = new Date().toISOString().split('T')[0];
const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id, startDate, endDate);
```

**AFTER:**

```typescript
// b. Get step analytics (unfiltered -- date filters drop opps, see 2026-03-18 bug)
const allAnalytics = await instantly.getStepAnalytics(workspace.id, campaign.id);
```

That's it. Remove 3 lines (516-518), change the comment on line 515, and remove the two trailing arguments from the `getStepAnalytics` call on line 519.

### Files NOT changed

- `src/instantly.ts` -- `startDate`/`endDate` params stay as optional. The rescan phase or future callers may need them.
- `src/instantly-direct.ts` -- Same, keep the optional params.
- `src/types.ts` -- No changes needed.
- `evaluator.ts`, `slack.ts`, `config.ts`, `leads-monitor.ts` -- No changes.

### Why the date filter is redundant

The sent count sanity check (lines 628-640) already catches campaigns with inflated sent data:

```typescript
if (contactedCount > 0 && step1TotalSent > contactedCount * 1.1) {
  // DATA INTEGRITY SKIP -- skips kill evaluation for this campaign
}
```

This handles the inflation problem the date filter was meant to solve, without breaking opportunity counts.

---

## Verification

After deploy, verify the fix by checking the next run's output:

1. **No more date filter params in the evaluation path.** Search the deployed code for `startDate, endDate` -- should only appear in the function signatures (instantly.ts, instantly-direct.ts), NOT in any `getStepAnalytics()` call site in index.ts.

2. **Opp counts match UI.** For the 5 affected campaigns, compare the worker's opp counts against the Instantly UI:
   - RG2161 Construction Steps 3/4/5
   - Restaurants RG2157-2160 Step 1
   - Summit Bridge Construction Step 3

3. **Sanity check still fires for inflated campaigns.** Any campaign with inflated sent counts should log `DATA INTEGRITY SKIP` and be skipped (not killed).

4. **No regression in kill accuracy.** The 6 correct kills from the 8am run (all 0-opp variants) should still be identified as kill candidates.

---

## Execution Instructions

1. `/technical` to load codebase context
2. Read `src/index.ts` lines 510-525
3. Apply the single change described above (remove lines 516-518, update line 515 comment, remove date args from line 519)
4. `tsc --noEmit` to verify TypeScript compiles
5. `/cc-review` loop until approved
6. Deploy: `cd builds/auto-turn-off && ./deploy.sh`
7. After deploy: verify `src/version.ts` has the new git hash, check Supabase for new `worker_version`, add row to `VERSION_REGISTRY.md`
8. Write handoff doc to `builds/auto-turn-off/specs/` with date prefix
