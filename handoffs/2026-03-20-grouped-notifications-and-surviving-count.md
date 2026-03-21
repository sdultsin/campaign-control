# Handoff: Grouped Notifications + Batch Surviving Count Fix

**Date:** 2026-03-20 (late night)
**Version:** `fa255ed`
**Deploy:** Cloudflare Workers, `auto-turnoff`
**Cron:** 0 10,16,22 * * * (6am/12pm/6pm ET)

---

## What shipped

### 1. Grouped Slack notifications
Previously, each kill/block/warning/rescan/leads alert sent its own parent message + thread reply to Slack. With 4+ kills in one run, channels got flooded.

Now: one parent message per notification type per channel (e.g. ":rotating_light: Variants Automatically Disabled (4)"), with individual variant details as thread replies underneath. Reduces channel noise significantly.

**Files:** `slack.ts` (new `NotificationCollector` class), `index.ts` (all 6 notification call sites converted to `collector.add()`, new Phase 5b flush)

### 2. Batch surviving variant count fix
When multiple variants in the same step were killed in one batch, the Slack message said "Step 1 now has only X active variants" with the wrong count -- it only excluded the current kill, not all kills in the batch.

Fix: added `allKillIndices` Set before the kill loop, changed the filter from `i !== kill.variantIndex` to `!allKillIndices.has(i)`.

**Impact:** Cosmetic only. Does NOT affect safety decisions -- `safetyCheck()` in `evaluator.ts` was already correct (uses its own cumulative `killSet`).

**Files:** `index.ts` lines 661-682

### 3. Date-range params on step analytics
`getStepAnalytics()` in both `instantly.ts` (MCP) and `instantly-direct.ts` (direct API) now accept optional `startDate`/`endDate` params. Not used by the main cron yet but available for future filtering.

### 4. KILLS_ENABLED=true
`wrangler.toml` now has `KILLS_ENABLED = "true"` committed. Previously was `false` in repo but manually set to `true` via dashboard.

---

## What did NOT change

- `evaluator.ts` -- safety logic untouched
- `config.ts` -- no config changes
- Kill cap (10/run), 7-day dedup, last-variant protection -- all preserved
- KV dedup keys -- all 6 types still written with correct TTLs
- Dual-write (KV + Supabase) -- preserved, Supabase writes now happen at flush time
- Dry run gating -- `collector.flush()` checks `isDryRun` and logs instead of sending

---

## Verification checklist

After next cron run, check:
- [ ] Slack notifications appear as grouped threads (one parent per type)
- [ ] Any step with multiple kills shows correct remaining count in thread replies
- [ ] `worker_version = 'fa255ed'` in Supabase `run_summaries`
- [ ] `notifications` table has `thread_ts` populated (same thread_ts for items in same group)
- [ ] LAST_VARIANT blocking still works when a step gets thin

---

## Dead code note

The old individual `send*Notification()` functions in `slack.ts` (lines 241-406) are now unused. They can be removed in a follow-up cleanup. Left in place to keep this deploy minimal and focused.
