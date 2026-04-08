# Handoff: kill_integrity false positive fix + writeAuditResult retry

**Date:** 2026-04-08
**Files changed:** `src/self-audit.ts`, `docs/layer2-knowledge.md`

## What Changed

1. `checkKillIntegrity` now checks the `error` field on both Supabase queries (audit_logs and dashboard_items). Query errors on dashboard_items lookups are tracked separately and skipped rather than counted as "missing." If all lookups error, the check returns SKIP instead of a false FAIL. Error counts are included in the result message.

2. `writeAuditResult` now retries once after a 1.5s delay if the initial insert fails. Both attempts log errors on failure. This addresses missing audit_results rows observed during deploy windows.

3. Added Bug Class #8 to `docs/layer2-knowledge.md` documenting the "Supabase error field ignored, null data treated as empty result" pattern.

## Why

kill_integrity was producing false positive FAILs (4 kills reported missing when they existed) because Supabase query errors returned null data, which was interpreted as "no matching rows." writeAuditResult had no retry, so transient Supabase failures during deploys caused missing audit_results rows.

## How to Verify Post-Deploy

- Next run with kills: check audit_results.check_results for kill_integrity. Should show PASS or SKIP, not FAIL with false missing counts.
- If a Supabase hiccup occurs during a run, kill_integrity should show SKIP with "lookup errors" message instead of false FAIL.
- Check that audit_results rows are consistently written (no gaps between consecutive runs).

## Risk Assessment

Low risk. Both changes are in the self-audit path (Phase 7) which is fire-and-forget. No impact on kill decisions, notifications, or dashboard writes. The retry adds at most 1.5s to audit duration on failure.
