# Campaign Control 6pm ET Cron Audit Runbook

**Date:** 2026-03-19
**Cron Time:** 22:00 UTC (6:00 PM ET)
**Worker:** `auto-turnoff` (Cloudflare Workers, account `8eb4f67f852e00194242db7f998cb06b`)
**Supabase Project:** `kczjvbbpwjrgbvomdawi` (campaign-control)
**KV Namespace:** `c054b62e43b54a22bcc1ffa24bb72272`

---

## Background: Why This Run Matters

This is the first full production cron run after a major fix deployed 2026-03-19 that switches Campaign Control from MCP-based Instantly API calls (15 minutes, caused Cloudflare to kill the worker mid-run) to direct Instantly API calls (~1-2 minutes).

**Earlier runs today were broken:**
- 6am ET (10:00 UTC): 1 audit_log entry, 1 campaign out of 65. Worker died at ~campaign 1.
- 12pm ET (16:00 UTC): 8 audit_log entries, 7 campaigns out of 65. Worker died at ~campaign 7.
- Root cause: No `ctx.waitUntil()`, MCP latency made each run ~15 minutes, Cloudflare killed it.

**What was fixed before 6pm:**
1. Direct Instantly API client (`src/instantly-direct.ts`) — bypasses MCP, ~50x faster
2. `ctx.waitUntil()` added to `scheduled()` handler
3. All 19 Supabase writes now properly `await`ed (were fire-and-forget)
4. Slack sleep times reduced (33s total → 4s total)
5. Concurrency bumped to 10 (cap 15) in direct mode
6. `INSTANTLY_MODE = "direct"` set in `wrangler.toml`

**Invisible HTTP test run at ~21:00 UTC confirmed:**
- Phase 1 (variant evaluation) completed in 52 seconds — direct API working
- 104 audit_log entries across 34 campaigns, 7 workspaces
- KV writes confirmed (heartbeat key present, 20K+ keys in production KV)
- Run stopped before phases 3-8 because HTTP triggers have shorter timeout than cron triggers
- Data accuracy verified by Sam: 4 variants checked against Instantly UI, 3 exact matches, 1 minor sent count delta

**Current settings:**
- `DRY_RUN = "false"`
- `KILLS_ENABLED = "false"` (kills paused — variants exceeding threshold are logged but NOT disabled in Instantly)
- `THRESHOLD = "4000"` (send:opportunity ratio)
- `CONCURRENCY_CAP = "5"` (default; direct mode bumps to 10, cap 15)

---

## Audit Scope

This runbook covers 8 checks to run after 22:00 UTC. Execute them in order. Each check has a "good" baseline and red flags.

---

## Check 1: Supabase — run_summaries

**What to check:** Exactly 1 new `run_summaries` row should appear after 22:00 UTC.

**Tool:** Campaign Control Supabase MCP (`mcp__campaign-control-supabase__execute_sql`)

```sql
-- Check for today's 6pm run summary
SELECT
  id,
  timestamp,
  worker_version,
  dry_run,
  campaigns_evaluated,
  workspaces_processed,
  variants_blocked,
  variants_warned,
  variants_disabled,
  leads_checked,
  ghost_re_enables,
  errors,
  duration_ms,
  ROUND(duration_ms / 1000.0, 1) AS duration_seconds
FROM run_summaries
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
ORDER BY timestamp DESC
LIMIT 3;
```

**What good looks like:**

| Field | Expected Value | Notes |
|-------|---------------|-------|
| `worker_version` | `v2` | Must be v2, never null |
| `dry_run` | `false` | Real run, not test |
| `campaigns_evaluated` | ~65 | All pilot campaigns. Under 60 = some workspaces skipped. |
| `workspaces_processed` | 8-9 | Pilot workspaces |
| `variants_blocked` | 50-70 | Variants exceeding threshold, last-variant protection applied |
| `variants_warned` | 2-6 | Approaching threshold |
| `variants_disabled` | 0 | Kills paused — should always be 0 |
| `leads_checked` | 10-15 | MCP still used for leads count |
| `ghost_re_enables` | 0 | No externally re-enabled killed variants |
| `errors` | 0 | Any non-zero needs investigation |
| `duration_ms` | < 300000 | Under 5 minutes. Previous runs were 900000+ and incomplete. |

**Also compare to earlier runs:**
```sql
-- Full recent run history for comparison
SELECT
  timestamp,
  campaigns_evaluated,
  variants_blocked,
  variants_warned,
  errors,
  duration_ms,
  dry_run,
  worker_version
FROM run_summaries
WHERE worker_version = 'v2'
ORDER BY timestamp DESC
LIMIT 5;
```

Expected: The 22:00 UTC run should have similar variant counts to the ~21:00 UTC HTTP test run but with `dry_run = false` and a longer duration (phases 3-8 completed, including leads check and Slack notifications). Duration should still be well under 5 minutes.

---

## Check 2: Supabase — daily_snapshots

**What to check:** Exactly 1 new `daily_snapshots` row for 2026-03-19.

```sql
-- Check today's daily snapshot
SELECT
  id,
  snapshot_date,
  total_campaigns,
  total_variants,
  active_variants,
  disabled_variants,
  jsonb_array_length(campaign_health) AS campaign_health_count,
  jsonb_object_keys(by_workspace) AS workspaces_in_snapshot
FROM daily_snapshots
WHERE snapshot_date = '2026-03-19'
ORDER BY created_at DESC
LIMIT 3;
```

```sql
-- Inspect workspace and CM distribution
SELECT
  snapshot_date,
  total_campaigns,
  total_variants,
  active_variants,
  disabled_variants,
  by_workspace,
  by_cm
FROM daily_snapshots
WHERE snapshot_date = '2026-03-19'
ORDER BY created_at DESC
LIMIT 1;
```

**What good looks like:**

| Field | Expected Value |
|-------|---------------|
| `snapshot_date` | `2026-03-19` |
| `total_campaigns` | ~65 |
| `total_variants` | 100-300 (depends on campaign structure) |
| `active_variants` | Majority of total_variants |
| `disabled_variants` | Small number (previously killed variants) |
| `campaign_health` | JSON array sorted by `healthPct` ascending (worst first) |
| `by_workspace` | JSON object with keys for all 8-9 pilot workspaces |
| `by_cm` | JSON object with keys for all 4 pilot CMs |

**Red flag:** If `daily_snapshots` is empty for 2026-03-19, the worker died before reaching Phase 7 (snapshot write). Check run_summaries for duration and errors.

---

## Check 3: Supabase — audit_logs

**What to check:** ~100-250 entries from the 6pm run. With `KILLS_ENABLED=false`, expect mostly `BLOCKED` and `WARNING` actions (no `DISABLED` — those only fire when kills are actually executed).

```sql
-- Count by action type for the 6pm run
SELECT
  action,
  COUNT(*) AS count
FROM audit_logs
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
GROUP BY action
ORDER BY count DESC;
```

```sql
-- Sample audit entries across different workspaces
SELECT
  timestamp,
  campaign,
  workspace,
  cm,
  step,
  variant_label,
  trigger_sent,
  trigger_opportunities,
  trigger_ratio,
  trigger_threshold,
  action,
  dry_run
FROM audit_logs
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
ORDER BY action, workspace
LIMIT 20;
```

**What good looks like:**

| Action | Expected | Notes |
|--------|---------|-------|
| `BLOCKED` | 30-60 entries | Variants exceeding threshold but not killed (last-variant protection) |
| `WARNING` | 2-6 entries | Variants approaching threshold |
| `DISABLED` | 0 entries | `KILLS_ENABLED=false` means kills are skipped entirely — no DISABLED entries written |
| `LEADS_EXHAUSTED` | 0-5 entries | Campaigns with no remaining contacts (check leads_audit_logs for details) |
| `LEADS_WARNING` | 0-5 entries | Low uncontacted leads |
| `GHOST_REENABLED` | 0 entries | Would indicate external interference |

**Note on DISABLED vs BLOCKED:** When `KILLS_ENABLED=false`, the batch kill section is skipped entirely. Variants that would normally be killed are instead logged as `BLOCKED` (last-variant protection) or not logged at all if they would be killed but there's no protection. The key distinction: `BLOCKED` means "would be killed but we're protecting it (last variant)"; there is no `DISABLED` entry written under `KILLS_ENABLED=false`.

**Red flag:** If total audit_log count < 50, the worker may have still died before completing Phase 1. Check `campaigns_evaluated` in run_summaries.

---

## Check 4: Supabase — notifications

**What to check:** 1 notification row per Slack message sent. Each threaded post (title + reply) counts as 1 notification record.

```sql
-- All notifications from the 6pm run
SELECT
  id,
  timestamp,
  notification_type,
  campaign,
  workspace,
  cm,
  channel_id,
  thread_ts,
  reply_success,
  message_ts
FROM notifications
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
ORDER BY timestamp
LIMIT 30;
```

```sql
-- Count by notification type
SELECT
  notification_type,
  COUNT(*) AS count,
  COUNT(CASE WHEN reply_success THEN 1 END) AS successful_replies,
  COUNT(CASE WHEN thread_ts IS NOT NULL THEN 1 END) AS threaded
FROM notifications
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
GROUP BY notification_type
ORDER BY count DESC;
```

**What good looks like:**

| Field | Expected |
|-------|---------|
| `notification_type` | One of: `WARNING`, `LAST_VARIANT`, `LEADS_EXHAUSTED`, `LEADS_WARNING` |
| `reply_success` | `true` on all entries |
| `thread_ts` | Non-null — title message was posted successfully |
| `channel_id` | Matches one of the 5 pilot channels (see Check 6) |

**Count expectations:**
- 1 notification per WARNING variant (expect 2-6)
- 1 notification per BLOCKED variant that hits the LAST_VARIANT condition
- 1 notification per leads-exhausted campaign
- Total expected: 5-20 notifications across all channels

**Red flag:** `reply_success = false` on any entry means Slack API failed after posting the title. The title is in Slack but the detail reply is missing.

---

## Check 5: Supabase — leads_audit_logs

**What to check:** Entries from Phase 3 (leads monitoring). MCP is still used for leads count — this is the phase most likely to be slow.

```sql
-- Leads check from the 6pm run
SELECT
  timestamp,
  campaign,
  workspace,
  cm,
  action,
  contacted,
  uncontacted,
  total,
  worker_version
FROM leads_audit_logs
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
ORDER BY timestamp
LIMIT 20;
```

```sql
-- Count by action
SELECT action, COUNT(*) AS count
FROM leads_audit_logs
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
GROUP BY action;
```

**What good looks like:**

| Field | Expected |
|-------|---------|
| `action` | `LEADS_EXHAUSTED`, `LEADS_WARNING`, or `LEADS_RECOVERED` |
| `contacted` | Non-null integer |
| `uncontacted` | Non-null integer |
| `total` | Non-null integer, = contacted + uncontacted |
| `worker_version` | `v2` |

**If `leads_audit_logs` is empty:** MCP connection for leads check failed. Look at `leads_checked` in run_summaries (should be 10-15). If `leads_checked = 0`, the MCP connection timed out during Phase 3.

---

## Check 6: KV State

**Tool:** Terminal (requires wrangler)

```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"

# MUST use --remote flag for production KV
npx wrangler kv key list --namespace-id c054b62e43b54a22bcc1ffa24bb72272 --remote --prefix "run:" 2>/dev/null | head -20
npx wrangler kv key list --namespace-id c054b62e43b54a22bcc1ffa24bb72272 --remote --prefix "snapshot:" 2>/dev/null | head -10
npx wrangler kv key get heartbeat --namespace-id c054b62e43b54a22bcc1ffa24bb72272 --remote 2>/dev/null
npx wrangler kv key list --namespace-id c054b62e43b54a22bcc1ffa24bb72272 --remote --prefix "auto-turnoff-lock" 2>/dev/null
```

**What good looks like:**

| Key Pattern | Expected After Run |
|-------------|-------------------|
| `run:2026-03-19T22:...` | New entry with timestamp after 22:00 UTC |
| `snapshot:2026-03-19` | Exists with today's date |
| `heartbeat` | Present, contains `"timestamp"` field with timestamp close to 22:05 UTC |
| `auto-turnoff-lock` | **Absent** — lock must be released after run completes |
| `log:...` keys | Multiple entries with recent timestamps |

**Check total KV key count (should be 20K+):**
```bash
npx wrangler kv key list --namespace-id c054b62e43b54a22bcc1ffa24bb72272 --remote 2>/dev/null | wc -l
```

**Red flag:** If `auto-turnoff-lock` key still exists after 22:10 UTC, the worker crashed mid-run and did not release the lock. Subsequent cron runs will be skipped until the lock expires (TTL is typically 30 minutes).

---

## Check 7: Slack Channel Verification

**Channels to check:**

| CM | Slack Channel | Channel ID |
|----|-------------|-----------|
| Alex | #cc-alex | C0AN70F328G |
| Carlos | #cc-carlos | C0AMRK81MRP |
| Ido | #cc-ido | C0AMRK842PK |
| Samuel | #cc-samuel | C0AMCMVLVDG |
| General (fallback) | #cc-general | C0AMRK8RC4R |

**Tool:** Slack MCP (`mcp__slack__slack_conversations_history`)

For each channel that had notifications in Check 4, verify:

1. Bot messages appeared between 22:00-22:10 UTC (6:00-6:10 PM ET)
2. Messages are threaded: title post with a reply in the thread (not two separate top-level messages)
3. No duplicate messages for the same variant
4. Message content matches the notification record in Supabase

**What to check in each relevant channel:**
```
- Message text references the campaign name (matches audit_log `campaign` field)
- Step number is correct (CC step 0 = Instantly UI Step 1, step 1 = Step 2, etc.)
- Variant letter is correct (A, B, C...)
- The ratio and threshold are visible in the message
- Reply in thread shows sent/opportunity counts
```

**Verification against Supabase:**
Pull the `thread_ts` from a notification record and confirm it matches a message timestamp in Slack. If `thread_ts` is set but no message exists in Slack at that timestamp, the Slack API accepted the message but it was deleted or lost.

---

## Check 8: Data Accuracy Spot-Checks

Pull 5-6 variants from audit_logs and have Sam verify in Instantly UI.

**Pull candidates:**
```sql
-- Get a spread of variants across different workspaces and CMs
SELECT
  id,
  campaign,
  workspace,
  cm,
  step,
  variant_label,
  trigger_sent,
  trigger_opportunities,
  ROUND(trigger_ratio, 0) AS ratio,
  trigger_threshold,
  action
FROM audit_logs
WHERE worker_version = 'v2'
  AND timestamp > '2026-03-19 22:00:00+00'
  AND action IN ('BLOCKED', 'WARNING')
ORDER BY cm, workspace, action
LIMIT 12;
```

**Select 5-6 to verify — target this spread:**
- 1 WARNING from Alex's workspace
- 1 WARNING from Carlos's workspace
- 1 BLOCKED from Ido's workspace
- 1 BLOCKED from a second Ido workspace (if Ido has multiple)
- 1 from Samuel's workspace (if available)
- 1 wildcard (any CM, any action)

**For each selected variant, Sam checks in Instantly UI:**

| CC Field | Instantly UI Location | Acceptable Delta |
|----------|--------------------|-----------------|
| `campaign` | Campaign name | Exact match |
| `step` (0-indexed) | Step number (add 1 for UI display) | Exact match |
| `variant_label` (A/B/C) | Variant letter | Exact match |
| `trigger_sent` | Sent count in step analytics | Within ~50 (slight drift is normal due to send timing) |
| `trigger_opportunities` | Opportunity count in step analytics | Exact match |

**If sent count delta > 100:** Direct API may be returning stale analytics. Flag for investigation but do not treat as a blocker unless opportunity counts are also wrong.

**If opportunity count is wrong:** Critical — this drives kill decisions. Note which workspace/campaign and investigate endpoint response shapes.

---

## Red Flags Summary

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| `run_summary` missing entirely after 22:10 UTC | Worker still dying mid-run | Tail CF logs: `npx wrangler tail auto-turnoff --format json` |
| `duration_ms > 600000` (10 min) | MCP leads phase running slow | Check `leads_checked` count; if 0, MCP timed out |
| `campaigns_evaluated < 60` | Workspaces skipped or campaign filter issue | Check error field; grep CF logs for workspace errors |
| `errors > 0` | API failures during run | Query audit_logs for error entries; check error messages |
| `auto-turnoff-lock` key present at 22:10 UTC | Worker crashed mid-run, lock not released | Wait for TTL expiry or manually delete the lock key |
| Duplicate Slack messages | KV dedup broken | Compare notification timestamps; check if KV writes succeeded |
| `leads_checked = 0` | MCP connection for leads failed | Check CF tail for MCP timeout errors in Phase 3 |
| `ghost_re_enables > 0` | Variant re-enabled externally | Identify which variant and investigate source |
| `daily_snapshots` empty for 2026-03-19 | Worker died before Phase 7 | Check `duration_ms` and phases completed in run_summary |
| `reply_success = false` in notifications | Slack API failure after title post | Slack rate limit or token issue; check #cc channels manually |
| Opportunity count wrong vs Instantly UI | Direct API response shape mismatch | Compare `/campaigns/analytics/steps` raw response to MCP output |

---

## Post-Audit Decision Tree

### If everything passes:
Campaign Control direct API mode is confirmed working end-to-end. All 7 phases complete, data accurate, Slack notifications sent correctly.

**Next step:** Resolve the opportunity vs possibility classification problem (IAMs marking all positive replies as "possibility" instead of "opportunity"). This is the gate before enabling kills (`KILLS_ENABLED=true`). Once classification is fixed and verified, flip the switch.

### If run_summary is missing or campaigns_evaluated < 30:
Worker is still dying before completion. Direct API phase works (confirmed by test run), but something in phases 3-8 is slow or crashing.

1. Tail logs during next cron run:
   ```bash
   cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
   npx wrangler tail auto-turnoff --format json
   ```
2. Look for structured log events: `run_start`, `workspace_complete`, `phase_start` — identify which phase is the last one logged before silence
3. If Phase 3 (leads/MCP) is the culprit, consider skipping leads check if MCP is unreachable

### If data accuracy spot-check fails (opportunity count wrong):
Direct API response shape mismatch. The `getStepAnalytics` endpoint may return opportunity counts differently than the MCP tool.

1. Make a direct API call and compare to MCP output:
   ```bash
   curl -H "Authorization: Bearer $INSTANTLY_API_KEY" \
     "https://api.instantly.ai/api/v2/campaigns/analytics/steps?workspace_id=WSID&campaign_id=CID&include_opportunities_count=true"
   ```
2. Compare field names to what MCP's `get_step_analytics` returns
3. If mismatch found: update field mapping in `src/instantly-direct.ts` and redeploy

### If Slack messages are missing:
1. Check `notifications` table — if records exist with `thread_ts` but no Slack message: Slack received it but something else happened (deleted, wrong channel)
2. If `thread_ts` is null: Slack API rejected the message. Check `reply_success` field and any error fields in notifications
3. Check channel IDs match the pilot channel list above
4. Fallback: `SLACK_FALLBACK_CHANNEL = "C0AMRK8RC4R"` (#cc-general) — check there for any overflow messages

### Fallback to MCP mode (nuclear option):
If direct API is fundamentally broken and can't be fixed quickly, revert to MCP mode:
```bash
# Edit wrangler.toml: set INSTANTLY_MODE = "mcp"
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
npx wrangler deploy
```
`ctx.waitUntil()` and `await` fixes still help even in MCP mode. The run will be slow (15 min) and may still die, but it's better than a broken direct API.

---

## Quick Reference: SQL Queries

```sql
-- 1. Run summary check
SELECT timestamp, campaigns_evaluated, workspaces_processed, variants_blocked, variants_warned,
       variants_disabled, leads_checked, ghost_re_enables, errors, duration_ms, dry_run
FROM run_summaries
WHERE worker_version = 'v2' AND timestamp > '2026-03-19 22:00:00+00'
ORDER BY timestamp DESC LIMIT 3;

-- 2. Audit log counts by action
SELECT action, COUNT(*) AS count
FROM audit_logs
WHERE worker_version = 'v2' AND timestamp > '2026-03-19 22:00:00+00'
GROUP BY action ORDER BY count DESC;

-- 3. Audit log sample for spot-check
SELECT id, campaign, workspace, cm, step, variant_label,
       trigger_sent, trigger_opportunities, ROUND(trigger_ratio, 0) AS ratio,
       trigger_threshold, action
FROM audit_logs
WHERE worker_version = 'v2' AND timestamp > '2026-03-19 22:00:00+00'
  AND action IN ('BLOCKED', 'WARNING')
ORDER BY cm, workspace, action LIMIT 12;

-- 4. Notification check
SELECT notification_type, COUNT(*) AS count,
       COUNT(CASE WHEN reply_success THEN 1 END) AS successful,
       COUNT(CASE WHEN thread_ts IS NOT NULL THEN 1 END) AS threaded
FROM notifications
WHERE worker_version = 'v2' AND timestamp > '2026-03-19 22:00:00+00'
GROUP BY notification_type ORDER BY count DESC;

-- 5. Daily snapshot check
SELECT snapshot_date, total_campaigns, total_variants, active_variants, disabled_variants
FROM daily_snapshots WHERE snapshot_date = '2026-03-19' ORDER BY created_at DESC LIMIT 1;

-- 6. Leads audit check
SELECT action, COUNT(*) AS count FROM leads_audit_logs
WHERE worker_version = 'v2' AND timestamp > '2026-03-19 22:00:00+00'
GROUP BY action;

-- 7. Compare all recent run summaries
SELECT timestamp, campaigns_evaluated, variants_blocked, variants_warned, errors, duration_ms, dry_run
FROM run_summaries WHERE worker_version = 'v2' ORDER BY timestamp DESC LIMIT 5;
```

---

## Quick Reference: KV Commands

```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
NS="c054b62e43b54a22bcc1ffa24bb72272"

# Check for post-run key
npx wrangler kv key list --namespace-id $NS --remote --prefix "run:" 2>/dev/null | grep "2026-03-19T22"

# Check snapshot key
npx wrangler kv key list --namespace-id $NS --remote --prefix "snapshot:" 2>/dev/null

# Check heartbeat
npx wrangler kv key get heartbeat --namespace-id $NS --remote 2>/dev/null

# Confirm lock is released (should return nothing)
npx wrangler kv key list --namespace-id $NS --remote --prefix "auto-turnoff-lock" 2>/dev/null

# Total key count (should be 20K+)
npx wrangler kv key list --namespace-id $NS --remote 2>/dev/null | wc -l
```

---

## Quick Reference: Wrangler Tail

To debug a live or upcoming cron run:
```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
npx wrangler tail auto-turnoff --format json
```

Look for these structured log events (written as `console.log(JSON.stringify({...}))`):
- `run_start` — worker fired, confirms cron trigger worked
- `workspace_complete` — each workspace processed
- `phase_start` — phases 1-8 boundary markers
- `run_complete` — entire run finished (if this appears, the run succeeded)
