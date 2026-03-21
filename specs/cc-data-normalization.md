# CC Spec: Legacy Data Normalization

**Date:** 2026-03-20
**Severity:** Low (data consistency, no functional impact on kill logic)
**Scope:** Supabase only — SQL migrations against `audit_logs`, `notifications`, `run_summaries`, `daily_snapshots`, `leads_audit_logs`. No code changes.
**CC-Review:** Not applicable (SQL data migrations only, no Worker code changes)

---

## What This Spec Covers

Normalize all legacy data in Supabase so it is consistent with the format produced by current (git-hash-tagged) Worker versions:

1. **Step numbers 1-indexed everywhere** — v1 (NULL) and v2 rows store 0-indexed step values. New data from git-hash-tagged deploys is 1-indexed per `cc-step-indexing-fix.md`.
2. **v1 data tagged** — rows with `worker_version IS NULL` are tagged as `'v1'` for queryability.
3. **Known bad data documented** — accuracy issues (wrong thresholds, broken Supabase sync, test data) are noted but not touched. This spec only normalizes FORMAT.

### Invariant

**DO NOT delete any rows.** Only `UPDATE` existing rows. All changes must be reversible or documented so the original state can be reconstructed.

---

## Current Data State

Measured via SQL on 2026-03-20.

### Row counts by version

| Table | NULL (v1) | v2 | git-hash |
|-------|------------|-----|----------|
| `audit_logs` | 18,127 | 694 | 0 |
| `notifications` | 105 | 33 | 0 |
| `run_summaries` | 59 | 4 | 0 |
| `daily_snapshots` | 2 | 1 | 0 |
| `leads_audit_logs` | 4 | 4 | 0 |

> Note: `notifications` has 33 total v2 rows but only 16 have non-NULL step values (the rest have `step = NULL` — LEADS_EXHAUSTED and LEADS_WARNING types, which are unaffected).

### Step value ranges before normalization

| Table | worker_version | min_step | max_step | rows with step |
|-------|----------------|----------|----------|----------------|
| `audit_logs` | NULL (v1) | 0 | 20 | 18,127 |
| `audit_logs` | v2 | 0 | 4 | 694 |
| `notifications` | NULL (v1) | 0 | 4 | 105 |
| `notifications` | v2 | 0 | 4 | 16 |

### v2 timestamp analysis

All 694 v2 `audit_logs` rows and all 16 v2 `notifications` rows with non-NULL step fall **before** `2026-03-20 13:43:00 UTC` (the `7b378479` deploy that introduced 1-indexed steps). There are zero post-fix v2 rows. The timestamp cutoff check is confirmed clean.

---

## What Needs to Be Done

### 1. Tag NULL rows as 'v1'

Tag all rows with `worker_version IS NULL` as `'v1'` across all 5 tables. This makes them queryable with `WHERE worker_version = 'v1'` instead of `WHERE worker_version IS NULL`.

Affects: 18,127 + 105 + 59 + 2 + 4 = **18,297 rows** across 5 tables.

### 2. Normalize step indexing for v1 rows

After tagging, add +1 to all `step` values in `audit_logs` and `notifications` for v1 rows. Only these two tables have a `step` column.

Affects: 18,127 `audit_logs` rows + 105 `notifications` rows = **18,232 rows**.

### 3. Normalize step indexing for v2 rows (pre-fix window only)

Add +1 to all `step` values in `audit_logs` and `notifications` for v2 rows timestamped before `2026-03-20 13:43:00 UTC`. As confirmed above, ALL current v2 rows fall in this window, so the timestamp filter is belt-and-suspenders.

Affects: 694 `audit_logs` rows + 16 `notifications` rows = **710 rows**.

---

## SQL Migrations

Run in this exact order. Each step is safe to re-run (idempotent after verification).

### Step 1: Tag v1 rows (all 5 tables)

```sql
UPDATE audit_logs SET worker_version = 'v1' WHERE worker_version IS NULL;
UPDATE notifications SET worker_version = 'v1' WHERE worker_version IS NULL;
UPDATE run_summaries SET worker_version = 'v1' WHERE worker_version IS NULL;
UPDATE daily_snapshots SET worker_version = 'v1' WHERE worker_version IS NULL;
UPDATE leads_audit_logs SET worker_version = 'v1' WHERE worker_version IS NULL;
```

### Step 2: Normalize step indexing for v1 rows

```sql
UPDATE audit_logs SET step = step + 1 WHERE worker_version = 'v1';
UPDATE notifications SET step = step + 1 WHERE worker_version = 'v1' AND step IS NOT NULL;
```

### Step 3: Normalize step indexing for v2 rows (pre-fix window)

```sql
UPDATE audit_logs
SET step = step + 1
WHERE worker_version = 'v2'
  AND timestamp < '2026-03-20 13:43:00+00';

UPDATE notifications
SET step = step + 1
WHERE worker_version = 'v2'
  AND step IS NOT NULL
  AND timestamp < '2026-03-20 13:43:00+00';
```

---

## Verification Queries

Run after all migrations complete.

### Check 1: No NULL worker_version rows remain

```sql
SELECT COUNT(*) as null_version_rows FROM audit_logs WHERE worker_version IS NULL;
SELECT COUNT(*) as null_version_rows FROM notifications WHERE worker_version IS NULL;
SELECT COUNT(*) as null_version_rows FROM run_summaries WHERE worker_version IS NULL;
SELECT COUNT(*) as null_version_rows FROM daily_snapshots WHERE worker_version IS NULL;
SELECT COUNT(*) as null_version_rows FROM leads_audit_logs WHERE worker_version IS NULL;
-- Expected: 0 for all
```

### Check 2: No 0-indexed steps remain

```sql
SELECT worker_version, MIN(step) as min_step, MAX(step) as max_step, COUNT(*) as rows
FROM audit_logs
GROUP BY worker_version;
-- Expected: min_step >= 1 for all versions (v1, v2, any git-hash)

SELECT worker_version, MIN(step) as min_step, MAX(step) as max_step, COUNT(*) as rows
FROM notifications
WHERE step IS NOT NULL
GROUP BY worker_version;
-- Expected: min_step >= 1 for all versions
```

### Check 3: Row counts unchanged (no deletions)

```sql
SELECT worker_version, COUNT(*) FROM audit_logs GROUP BY worker_version ORDER BY worker_version;
-- Expected: v1=18127, v2=694 (plus any git-hash rows written after this migration)
```

### Expected after-state (step ranges)

| Table | worker_version | min_step | max_step |
|-------|----------------|----------|----------|
| `audit_logs` | v1 | 1 | 21 |
| `audit_logs` | v2 | 1 | 5 |
| `notifications` | v1 | 1 | 5 |
| `notifications` | v2 | 1 | 5 |

---

## What Is NOT Changed

### Tables with no step column

`run_summaries`, `daily_snapshots`, and `leads_audit_logs` have no `step` column. They only receive the `worker_version` tag in Step 1. No step normalization applies.

### v2 data accuracy issues

The VERSION_REGISTRY documents accuracy problems with v2 data that this migration does not fix:

| Time window | Known accuracy issue | Action |
|-------------|---------------------|--------|
| 2026-03-18 to 2026-03-19 ~15:00 UTC | Supabase writes dropped (fire-and-forget race) — rows may be missing entirely | Document only |
| 2026-03-19 ~15:00 to ~22:00 UTC | `dry_run=true` on all entries — test data | Filter with `WHERE dry_run = false` |
| 2026-03-19 ~22:00 UTC (4840a9a1) | `leads_checked=0` (MCP failure) | Document only |
| 2026-03-20 ~10:00 UTC crash | `run_summaries` and `daily_snapshots` missing for this run | Document only |

These rows are preserved as-is. The step normalization makes them consistently formatted but does not repair accuracy.

### Post-fix v2 rows (none currently exist)

Any v2 rows written after `2026-03-20 13:43:00 UTC` would already be 1-indexed per `cc-step-indexing-fix.md`. The timestamp filter in Step 3 protects them from double-increment. As of this migration, zero such rows exist.

### git-hash-tagged rows

Rows with a git short hash as `worker_version` (e.g., `7b95a92`) are already 1-indexed. They are not touched by any migration step.

---

## Risk Assessment

**Very low risk.** All changes are `UPDATE` only, no `DELETE`. The most critical risk is double-incrementing v2 rows that are already 1-indexed — mitigated by the timestamp filter confirmed clean via SQL before writing this spec.

| Risk | Mitigation |
|------|-----------|
| Double-increment post-fix v2 rows | Timestamp filter `< '2026-03-20 13:43:00+00'` confirmed to cover all 694 v2 rows |
| Double-increment v1 rows if migration re-run | Run verification Check 2 first; min_step >= 1 means migration already ran |
| Wrong row count after tagging | Verification Check 3 confirms row counts unchanged |
| git-hash rows affected | None exist in v1 or v2 version groups; git-hash rows excluded by version filter |

---

## Reversibility

If the migration needs to be undone:

```sql
-- Undo step normalization (subtract 1)
UPDATE audit_logs SET step = step - 1 WHERE worker_version IN ('v1', 'v2');
UPDATE notifications SET step = step - 1 WHERE worker_version IN ('v1', 'v2') AND step IS NOT NULL;

-- Undo v1 tagging (restore NULL)
UPDATE audit_logs SET worker_version = NULL WHERE worker_version = 'v1';
UPDATE notifications SET worker_version = NULL WHERE worker_version = 'v1';
UPDATE run_summaries SET worker_version = NULL WHERE worker_version = 'v1';
UPDATE daily_snapshots SET worker_version = NULL WHERE worker_version = 'v1';
UPDATE leads_audit_logs SET worker_version = NULL WHERE worker_version = 'v1';
```

Note: the undo for step normalization cannot distinguish v2 pre-fix from v2 post-fix (if any post-fix rows exist by then). Run reversals only if all current v2 rows are still pre-fix.

---

## Execution Instructions

1. Use `/technical` persona to execute the SQL migrations in order (Steps 1, 2, 3)
2. Run verification queries after each step
3. Present results in a before/after table showing row counts and step ranges
4. Update `VERSION_REGISTRY.md` to note that legacy data has been normalized (add a note under both the NULL and v2 sections)
5. Write a handoff document to `builds/auto-turn-off/handoffs/` with: what was normalized, row counts affected, before/after verification results. This handoff is for the main chat to pick up context.
6. Run `/cc-review` is NOT applicable — no Worker code changes.
