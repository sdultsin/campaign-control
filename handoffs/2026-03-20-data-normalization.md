# Handoff: Legacy Data Normalization

**Date:** 2026-03-20
**Spec:** `specs/cc-data-normalization.md`
**Type:** SQL data migration (no code changes)

## What Was Done

Normalized all legacy Supabase data so step indexing and version tagging are consistent with current git-hash-tagged Worker output.

### Migration Steps Executed

1. **Tagged NULL rows as 'v1'** across all 5 tables (audit_logs, notifications, run_summaries, daily_snapshots, leads_audit_logs)
2. **Added +1 to step values for v1 rows** in audit_logs and notifications
3. **Added +1 to step values for v2 rows** (pre-fix window, before 2026-03-20 13:43:00 UTC) in audit_logs and notifications

### Rows Affected

| Table | Step 1 (v1 tag) | Step 2 (v1 step +1) | Step 3 (v2 step +1) |
|-------|-----------------|---------------------|---------------------|
| `audit_logs` | 18,127 | 18,127 | 694 |
| `notifications` | 105 | 105 | 16 |
| `run_summaries` | 59 | n/a (no step column) | n/a |
| `daily_snapshots` | 2 | n/a (no step column) | n/a |
| `leads_audit_logs` | 4 | n/a (no step column) | n/a |

### Verification Results

**All checks passed.**

| Check | Result |
|-------|--------|
| No NULL worker_version rows | 0 across all 5 tables |
| audit_logs v1 step range | 1-21 (was 0-20) |
| audit_logs v2 step range | 1-5 (was 0-4) |
| notifications v1 step range | 1-5 (was 0-4) |
| notifications v2 step range | 1-5 (was 0-4) |
| Row counts unchanged | v1=18,127, v2=694 (audit_logs) |

## What Changed for Queries

- **Before:** `WHERE worker_version IS NULL` to find v1 data, steps 0-indexed for v1/v2
- **After:** `WHERE worker_version = 'v1'` to find v1 data, steps 1-indexed everywhere

## What Was NOT Changed

- v2 accuracy issues (dropped writes, dry_run=true test data, leads_checked=0) are preserved as-is
- No rows deleted
- git-hash-tagged rows untouched (already 1-indexed)
- VERSION_REGISTRY.md updated with normalization notes

## Reversibility

Full reversal SQL is documented in the spec. Safe to reverse as long as no post-fix v2 rows exist (none do currently).
