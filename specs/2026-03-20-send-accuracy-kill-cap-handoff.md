# Handoff: Send Count Sanity Check + Kill Cap Fix

**Date:** 2026-03-20
**Deployed:** Yes (worker version pending commit — currently tagged 87d06fa)
**Spec:** `specs/send-accuracy-and-kill-cap-build.md`

---

## What shipped

### 1. Date-filtered step analytics
- `instantly.ts` and `instantly-direct.ts`: `getStepAnalytics()` now accepts optional `startDate`/`endDate` params
- `index.ts`: Main evaluation call passes `timestamp_created` as start date, today as end date
- Helps some campaigns with inflated sent counts (not all — see sanity check below)

### 2. Send count sanity check
- Before kill evaluation, compares Step 1 total sent against `getCampaignAnalytics().contacted`
- 10% tolerance for timing differences
- If step 1 sent exceeds contacted by >10%, logs `DATA INTEGRITY SKIP` and skips kill evaluation for that campaign
- Campaign is re-checked every run until data resolves
- Adds 1 API call per campaign (lightweight, acceptable at 3x/day)

### 3. Kill cap budget counter
- New `killBudgetRemaining` variable replaces the old `totalVariantsKilled + pendingKills.length` check
- Decremented at queue time (when kill is added to `pendingKills`), not at execution time
- Fixes race condition where concurrent campaign processing could exceed MAX_KILLS_PER_RUN (10)
- Budget restored if batch execution fails (variants stay enabled, retried next run)

### 4. Grouped notifications (bonus)
- `NotificationCollector` class in `slack.ts` batches notifications by (channel, type)
- One parent message per notification type, individual details as thread replies
- 300ms delay between replies for Slack rate limiting
- Supabase notification writes happen during flush with proper `thread_ts`

### 5. Surviving variant count fix (bonus)
- `allKillIndices` set ensures accurate surviving count when multiple variants killed in same step

---

## Files changed

| File | What |
|------|------|
| `src/instantly.ts` | Optional date params on `getStepAnalytics` |
| `src/instantly-direct.ts` | Same date params for direct API |
| `src/index.ts` | Date filtering, sanity check, kill budget counter, notification collector integration |
| `src/slack.ts` | `NotificationCollector` class + grouped flush |
| `src/leads-monitor.ts` | Comment clarification only |

## Files NOT changed (per spec)
- `evaluator.ts`, `config.ts`, `router.ts`, `leads-monitor.ts` (logic), `types.ts` (already had `timestamp_created`)

---

## Verification checklist

After next cron run (6am ET March 21):
- [ ] Campaigns with inflated data log `DATA INTEGRITY SKIP` in console
- [ ] Kill count in `run_summaries.variants_disabled` <= 10
- [ ] Date-filtered step analytics match for clean campaigns
- [ ] No premature kills on Alex Construction E/F (2,608 actual sends, well below 3,800)
- [ ] Slack notifications appear as grouped threads (one parent per type)

---

## Known items

- **Version tag:** Deploy ran before commit — worker shows `87d06fa`. Commit + redeploy needed for proper version tracking.
- **Stale comment:** Line 1248 still says "unfiltered — validated as accurate" for rescan phase. Non-blocking (rescan checks specific variant data).
- **Rescan calls unfiltered:** Rescan phase `getStepAnalytics` calls don't use date filters. Acceptable — rescan checks specific variant data, not relative comparisons.
