# CC Spec: Invisible Test Run — 2026-03-20 Changes Verification

**Date:** 2026-03-20
**Severity:** N/A (verification task, not a bug fix)
**Scope:** `wrangler.toml` (DRY_RUN toggle), Supabase queries, KV checks
**Current deployed version:** `7b95a92`

---

## What This Is

An "invisible run" is a dry run with `DRY_RUN=true`. In this mode:

- No Slack notifications are sent
- No Instantly API calls to disable or enable variants
- Everything else runs normally: evaluation, audit logging (KV + Supabase), snapshot, run summary, leads check via direct API

The purpose of this run is to verify all four changes made on 2026-03-20 are working correctly before the noon production cron fires. The production cron runs at `0 10,16,22 * * *` UTC — the 10:00 UTC slot is the target noon ET run.

---

## Changes Being Verified

### 1. Step Indexing (1-indexed)

**Spec:** `specs/cc-step-indexing-fix.md`

All `step` values in `audit_logs` and `notifications` should now be 1-indexed to match the Instantly UI. Previously 0-indexed. The fix touched 7 `AuditEntry` constructions and 4 `NotificationRecord` constructions in `index.ts`.

**What to look for:** No `step = 0` values in audit_logs or notifications from the test run.

### 2. Skip Already-Disabled Variants

**Spec:** `specs/cc-skip-disabled-variants.md`

Campaigns where all variants in a step are already disabled (like "PRESIDENTS" in The Eagles) should be skipped entirely at the step level. The fix added an all-disabled gate in `index.ts` before `evaluateStep` is called, and strengthened the `!v.v_disabled` truthy check in `evaluator.ts`.

**What to look for:** Zero `audit_logs` rows for the PRESIDENTS campaign. A `[auto-turnoff] Step X ... all variants disabled, skipping` log line in Cloudflare Worker logs.

### 3. Leads via Direct API (no MCP)

**Spec:** `specs/cc-leads-direct-api.md`

The leads check phase (Phase 3) now uses `getBatchCampaignAnalytics()` on `InstantlyDirectApi` — one API call per workspace — instead of N serial MCP calls per candidate campaign. The MCP reconnect block before Phase 3 was removed.

**What to look for:**
- `leads_checked > 0` in run_summaries
- `leads_audit_logs` entries populated with real numbers
- No "MCP reconnected for leads check" line in Cloudflare logs
- `duration_ms` well under 300,000ms

### 4. Version Tagging (git hash)

**Spec:** `specs/cc-version-tagging.md`

`worker_version` in all 5 Supabase tables should be the git short hash (`7b95a92`), not `'v2'`. This was deployed at ~20:XX UTC on 2026-03-20.

**What to look for:** All tables show `7b95a92` (or the current hash if redeployed). No `'v2'` in new rows.

---

## Pre-Run State

Before triggering the test run, confirm the following:

- `wrangler.toml` has `DRY_RUN = "false"` currently (it does — this is production state)
- `wrangler.toml` has `KILLS_ENABLED = "false"` (confirmed — kills are still paused)
- Current deployed version is `7b95a92` (from VERSION_REGISTRY.md)
- No stale lock in KV: confirm `auto-turnoff-lock` key is absent or expired

---

## Triggering the Invisible Run

### Step 1: Set DRY_RUN=true in wrangler.toml

In `builds/auto-turn-off/wrangler.toml`, change:

```toml
DRY_RUN = "false"
```

to:

```toml
DRY_RUN = "true"
```

Do not change any other env vars.

### Step 2: Deploy with ./deploy.sh

```bash
cd "builds/auto-turn-off"
./deploy.sh
```

Confirm the deploy output shows the correct git hash (should still be `7b95a92` if no new commits).

### Step 3: Trigger the cron

The production cron schedule is `0 10,16,22 * * *` UTC. Options:

**Option A (cron hack — preferred for immediate verification):**

1. Change the cron in `wrangler.toml` to `*/1 * * * *`
2. Redeploy with `./deploy.sh`
3. Wait up to 2 minutes for the cron to fire
4. Revert the cron back to `0 10,16,22 * * *`
5. Redeploy once more (still with `DRY_RUN=true`) before running verification

**Option B (wait for scheduled run):**

If the 10:00 UTC cron slot is imminent (within 15 minutes), simply wait. No cron change needed.

### Step 4: Confirm the run completed

A run takes approximately 2-3 minutes. Watch for completion by:
- Checking Cloudflare Worker logs for `[auto-turnoff] Run complete` or similar end-of-run marker
- Querying `run_summaries` for a new row with `worker_version = '7b95a92'` and `dry_run = true`

Do not run verification queries until the run is confirmed complete.

---

## Verification Queries

Run all of the following against the Campaign Control Supabase project (`kczjvbbpwjrgbvomdawi`). The filter `WHERE worker_version NOT IN ('v1', 'v2')` isolates new git-hash-tagged rows.

### Check 1: Run summary exists with correct version

```sql
SELECT timestamp, worker_version, campaigns_evaluated, workspaces_processed,
       variants_blocked, variants_warned, variants_disabled, leads_checked,
       errors, duration_ms, dry_run
FROM run_summaries
WHERE worker_version NOT IN ('v1', 'v2')
ORDER BY timestamp DESC LIMIT 1;
```

**Expected:**
- 1 row returned
- `worker_version` = `7b95a92` (or current hash)
- `dry_run` = `true`
- `leads_checked` > 0
- `errors` = 0
- `duration_ms` < 300,000

### Check 2: Audit logs have 1-indexed steps

```sql
SELECT step, variant_label, action, worker_version
FROM audit_logs
WHERE worker_version NOT IN ('v1', 'v2')
ORDER BY timestamp DESC LIMIT 10;
```

**Expected:**
- All `step` values >= 1 (never 0)
- `worker_version` = `7b95a92` consistently

### Check 3: No BLOCKED entries for all-disabled campaigns (PRESIDENTS)

```sql
SELECT campaign, step, variant_label, action
FROM audit_logs
WHERE worker_version NOT IN ('v1', 'v2')
  AND campaign LIKE '%PRESIDENTS%';
```

**Expected:** 0 rows. The PRESIDENTS campaign in The Eagles has all variants disabled — the all-disabled gate should prevent any audit entries from being written.

### Check 4: Daily snapshot exists

```sql
SELECT date, total_campaigns, total_variants, active_variants, disabled_variants,
       above_threshold, actions_blocked, actions_warned, worker_version
FROM daily_snapshots
WHERE worker_version NOT IN ('v1', 'v2')
ORDER BY created_at DESC LIMIT 1;
```

**Expected:**
- 1 row returned
- `worker_version` = `7b95a92`
- Counts are non-zero and plausible (18 workspaces, 140 campaigns)

### Check 5: Leads audit logs exist with real data

```sql
SELECT campaign, action, worker_version,
       leads->>'total' as total,
       leads->>'contacted' as contacted,
       leads->>'uncontacted' as uncontacted
FROM leads_audit_logs
WHERE worker_version NOT IN ('v1', 'v2')
ORDER BY timestamp DESC LIMIT 5;
```

**Expected:**
- At least 1 row returned (if any campaigns are leads-check candidates)
- `worker_version` = `7b95a92`
- `total`, `contacted`, `uncontacted` are non-null real numbers (not all zeros)
- `skipped` in the full JSONB will be 0 (expected — not available from analytics endpoint)

### Check 6: Notifications have 1-indexed steps and correct version

```sql
SELECT notification_type, step, variant_label, worker_version, dry_run
FROM notifications
WHERE worker_version NOT IN ('v1', 'v2')
ORDER BY timestamp DESC LIMIT 10;
```

**Expected:**
- `dry_run` = `true` on all rows (no Slack messages sent)
- `step` values >= 1 where non-null (never 0)
- `worker_version` = `7b95a92`

*Note: Notifications rows are only written when evaluation produces actions (kills, warnings, blocks). If the test run finds no above-threshold variants, this table may return 0 rows — that is acceptable. Verify against audit_logs count instead.*

### Check 7: Worker version consistent across all tables

```sql
SELECT 'audit_logs' as tbl, worker_version, COUNT(*) FROM audit_logs
  WHERE worker_version NOT IN ('v1', 'v2', '') AND worker_version IS NOT NULL
  GROUP BY worker_version
UNION ALL
SELECT 'notifications', worker_version, COUNT(*) FROM notifications
  WHERE worker_version NOT IN ('v1', 'v2', '') AND worker_version IS NOT NULL
  GROUP BY worker_version
UNION ALL
SELECT 'run_summaries', worker_version, COUNT(*) FROM run_summaries
  WHERE worker_version NOT IN ('v1', 'v2', '') AND worker_version IS NOT NULL
  GROUP BY worker_version
UNION ALL
SELECT 'daily_snapshots', worker_version, COUNT(*) FROM daily_snapshots
  WHERE worker_version NOT IN ('v1', 'v2', '') AND worker_version IS NOT NULL
  GROUP BY worker_version
UNION ALL
SELECT 'leads_audit_logs', worker_version, COUNT(*) FROM leads_audit_logs
  WHERE worker_version NOT IN ('v1', 'v2', '') AND worker_version IS NOT NULL
  GROUP BY worker_version;
```

**Expected:** All rows in all tables show the same git hash (`7b95a92`). No mix of hashes unless there was a redeploy mid-run (which there should not be).

---

## KV Checks

After the run, verify KV state using Wrangler:

```bash
cd "builds/auto-turn-off"

# Check 1: Confirm run summary key was written (format: run:<timestamp>)
npx wrangler kv key list --namespace-id=c054b62e43b54a22bcc1ffa24bb72272 --prefix="run:" | tail -5

# Check 2: Confirm log entries were written from this run
# (format: log:<timestamp>:<campaignId>:<step>:<variant>)
# Steps will be 1-indexed now, e.g., log:...:1:0 not log:...:0:0
npx wrangler kv key list --namespace-id=c054b62e43b54a22bcc1ffa24bb72272 --prefix="log:" | tail -20

# Check 3: Confirm no stale lock remains after the run completes
npx wrangler kv key get --namespace-id=c054b62e43b54a22bcc1ffa24bb72272 "auto-turnoff-lock"
# Expected: key not found (lock was released at end of run)
```

**Expected:**
- At least one `run:` key from the current run timestamp
- Multiple `log:` keys with 1-indexed step numbers in the key path
- `auto-turnoff-lock` key absent (run completed cleanly and released the lock)

---

## Pass/Fail Criteria

Present results in this table after all queries:

| Check | What | Pass Criteria | Result |
|-------|------|---------------|--------|
| 1 | Run summary | Exists, dry_run=true, errors=0, leads_checked>0, duration<300k | |
| 2 | Step indexing | All step values >= 1 in audit_logs | |
| 3 | Skip disabled | 0 PRESIDENTS rows in audit_logs | |
| 4 | Daily snapshot | Exists with correct worker_version | |
| 5 | Leads direct API | leads_audit_logs has rows with real numbers | |
| 6 | Notifications | dry_run=true, steps 1-indexed where non-null | |
| 7 | Version consistency | Same git hash across all 5 tables | |
| 8 | KV lock released | auto-turnoff-lock absent after run | |
| 9 | KV log entries | log: keys present with 1-indexed steps | |
| 10 | Duration (MCP gone) | duration_ms < 300,000ms | |

A result of PASS on all 10 checks clears the build for production.

---

## Reverting to Production Config

After all verification queries are complete and results are recorded:

### Step 1: Change DRY_RUN back to false

In `builds/auto-turn-off/wrangler.toml`, change:

```toml
DRY_RUN = "true"
```

back to:

```toml
DRY_RUN = "false"
```

Also revert the cron if the cron hack was used:

```toml
crons = ["0 10,16,22 * * *"]
```

### Step 2: Deploy with ./deploy.sh

```bash
cd "builds/auto-turn-off"
./deploy.sh
```

### Step 3: Confirm production config is clean

Run `/cc-review` on the final state. All 8 checklist items must pass. Specifically confirm:
- `DRY_RUN = "false"` in deployed config
- `KILLS_ENABLED = "false"` (unchanged — kills remain paused until Sam explicitly enables)
- Cron schedule is back to `0 10,16,22 * * *`

---

## Execution Instructions

1. Use `/technical` persona to implement all steps
2. Confirm no stale KV lock before starting (run the KV lock check first)
3. Change `DRY_RUN` to `"true"` in `wrangler.toml`
4. Deploy with `./deploy.sh`
5. Trigger a cron run using the cron hack (`*/1 * * * *`) or wait for the next scheduled slot
6. Wait for run completion (~2-3 minutes) — confirm via Cloudflare logs or run_summaries row
7. Execute ALL 7 Supabase verification queries above
8. Execute ALL 3 KV checks above
9. Present results in the pass/fail table
10. Change `DRY_RUN` back to `"false"` in `wrangler.toml` (and revert cron if changed)
11. Deploy with `./deploy.sh` to restore production config
12. Run `/cc-review` on the final state to confirm production config is clean
13. Write a handoff document to `builds/auto-turn-off/handoffs/` named `2026-03-20-invisible-test-run.md` with:
    - The full pass/fail results table with actual values filled in
    - Any FAIL items and their root cause
    - Final deployed version hash
    - Confirmation that DRY_RUN=false is live
    - Any issues to watch in the noon production run

The handoff is for the main chat to pick up context and decide whether to green-light the noon production run.
