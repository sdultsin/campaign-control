# Handoff: Skip OFF Campaigns in Evaluation Loop

**Version:** `782c0c8`
**Deployed:** 2026-03-25
**Spec:** `specs/off-campaign-skip.md`
**CC Review:** APPROVED (1 round)

## What Changed

Two lines in `src/index.ts`:

1. **Line 634:** Early return for OFF campaigns after pilot filter, before any API calls or evaluation
2. **Line 604:** Console log changed from `(X OFF, buffered)` to `(X OFF, skipped)`

## Why

OFF campaigns were being fully evaluated (API calls for details + analytics, kill/block/winner checks, leads monitoring, snapshot collection) with a 1.2x threshold buffer. This wasted API calls on campaigns CMs intentionally turned off. Stale data, zero operational impact from any action taken.

## What It Does

- OFF campaigns still appear in the campaign count (fetched for logging)
- They get an early return with `evaluated: false` -- no API calls, no kills, no warnings, no blocks, no leads monitoring, no ghost detection, no snapshots
- The 1.2x OFF buffer in `resolveThreshold()` is now dead code for the eval path (only non-OFF campaigns reach it). Can clean up later.

## What to Verify

1. **Next run's console logs:** Should show `(X OFF, skipped)` instead of `(X OFF, buffered)`
2. **run_summaries:** `campaigns_evaluated` should be lower (OFF campaigns no longer counted as evaluated)
3. **No OFF campaign entries** in audit_logs, dashboard_items, or daily_snapshots going forward
4. **Phase 7 self-audit:** Should still pass GREEN -- fewer evaluated campaigns is expected, not an error

## Rollback

Revert commit `782c0c8` and redeploy. OFF campaigns would resume evaluation with the 1.2x buffer. No data loss risk.
