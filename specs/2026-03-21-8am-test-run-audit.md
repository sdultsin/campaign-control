# 8am ET Test Run Audit — March 21, 2026

**Run time:** 8am ET = 12:00 UTC
**Worker version expected:** `0d78ca0`
**Previous run:** 6am ET March 21 (10:01 UTC), version `a1cbf1c`, **62/62 errors** (0 kills, 0 blocked, 0 warned)
**Root cause of 6am failure:** `getCampaignAnalytics` used wrong URL pattern (`/campaigns/{id}/analytics` path param instead of `/campaigns/analytics?campaign_id=` query param), causing 404 on every campaign
**What this run validates:** The URL fix from `d6145dc`/`0d78ca0`, plus all features from `fa255ed` that never got a clean run (grouped notifications, sanity check, kill cap budget, surviving count fix)

---

## Part 1: Agent Verification (automated)

Run these checks immediately after the 8am cron fires (~12:02 UTC). All queries use CC Supabase (project `kczjvbbpwjrgbvomdawi`).

### 1.0 Confirm 6am run had 62 errors (regression baseline)

```sql
SELECT worker_version, timestamp, campaigns_evaluated, errors, variants_disabled, variants_blocked, variants_warned, dry_run
FROM run_summaries
WHERE timestamp >= '2026-03-21 09:50:00+00' AND timestamp < '2026-03-21 11:00:00+00'
ORDER BY timestamp DESC
LIMIT 1;
```

**Expected:** `worker_version = 'a1cbf1c'`, `errors = 62`, `variants_disabled = 0`. This confirms the broken run we're fixing. If this doesn't match, investigate before interpreting the 8am results.

### 1.1 Confirm correct worker version and 0 errors

```sql
SELECT worker_version, timestamp, campaigns_evaluated, variants_disabled, variants_blocked, variants_warned, errors, dry_run
FROM run_summaries
WHERE timestamp >= '2026-03-21 11:50:00+00'
ORDER BY timestamp DESC
LIMIT 3;
```

**Expected:** `worker_version = '0d78ca0'`, `errors = 0`. If errors > 0, the fix didn't work or there's a new issue. If it shows `a1cbf1c`, the deploy didn't take.

### 1.2 Kill cap enforcement

From the same `run_summaries` result:

**Expected:** `variants_disabled <= 10`. The previous run had 15 (cap was broken). If still >10, the kill cap fix didn't ship.

### 1.3 Sanity check firing

Check Cloudflare Worker logs for `DATA INTEGRITY SKIP` entries. If log access isn't available, query audit_logs for campaigns that were evaluated in the 7pm run but are now missing from the 8am run:

```sql
-- Campaigns evaluated at 7pm (last clean run)
SELECT DISTINCT campaign, cm
FROM audit_logs
WHERE timestamp >= '2026-03-20 23:00:00+00' AND timestamp < '2026-03-20 23:05:00+00'
  AND worker_version = '87d06fa'
ORDER BY campaign;

-- Campaigns evaluated at 8am
SELECT DISTINCT campaign, cm
FROM audit_logs
WHERE timestamp >= '2026-03-21 11:58:00+00' AND timestamp < '2026-03-21 12:05:00+00'
  AND worker_version = '0d78ca0'
ORDER BY campaign;
```

**Expected:** Some campaigns from the 7pm list may be ABSENT from the 8am list — those are the ones that got `DATA INTEGRITY SKIP`'d due to inflated sent counts. This is correct behavior. Report which campaigns were skipped.

### 1.4 No premature kills on Alex Construction

```sql
SELECT campaign, step, variant_label, action, trigger_sent, trigger_opportunities
FROM audit_logs
WHERE campaign ILIKE '%Construction (Alex)%'
  AND timestamp >= '2026-03-21 11:58:00+00'
  AND action IN ('DISABLED', 'DEFERRED')
ORDER BY timestamp;
```

**Expected:** ZERO rows. Alex Construction E/F have only ~2,608 actual sends (well below 3,800 threshold). If any DISABLED rows appear, the sanity check or date filter isn't working — report immediately.

### 1.5 Grouped notifications format

Pull the 6am run messages from all 4 CC Slack channels:
- `#cc-alex` (C0AN70F328G)
- `#cc-carlos` (C0AMRK81MRP)
- `#cc-ido` (C0AMRK842PK)
- `#cc-samuel` (C0AMCMVLVDG)

Use `slack_conversations_history` with `oldest` = unix timestamp for 2026-03-21 11:58:00 UTC.

**Expected format:** One parent message per notification type (e.g., ":rotating_light: Variants Automatically Disabled (N)") with individual variant details as thread replies. NOT individual top-level messages for each variant.

### 1.6 Surviving variant count accuracy

For any step where multiple variants were killed in this run, check the thread replies:

```sql
SELECT campaign, step, variant_label, action,
       trigger_sent, trigger_opportunities,
       safety_surviving_variants
FROM audit_logs
WHERE action = 'DISABLED'
  AND timestamp >= '2026-03-21 11:58:00+00'
  AND worker_version = '0d78ca0'
ORDER BY campaign, step, timestamp;
```

For each step with 2+ kills, verify `safety_surviving_variants` reflects the count AFTER all batch kills, not just after the individual kill. Cross-reference against the step's total variant count from `get_campaign_details`.

### 1.7 LAST_VARIANT protection still works

```sql
SELECT campaign, step, variant_label, action, safety_surviving_variants, safety_notification
FROM audit_logs
WHERE action = 'BLOCKED' AND safety_notification = 'LAST_VARIANT'
  AND timestamp >= '2026-03-21 11:58:00+00'
ORDER BY timestamp;
```

**Expected:** Any rows here mean the last-variant protection fired correctly. If a step has ALL variants DISABLED (none BLOCKED as LAST_VARIANT), that's a safety failure — report immediately.

### 1.8 Deferred variants (kill cap overflow)

```sql
SELECT campaign, step, variant_label, trigger_sent, trigger_opportunities, trigger_ratio
FROM audit_logs
WHERE action = 'DEFERRED'
  AND timestamp >= '2026-03-21 11:58:00+00'
ORDER BY campaign, step;
```

**Expected:** If variants_disabled = 10, there should be DEFERRED entries for the overflow. Report the count — these will be picked up in the 12pm run.

---

## Part 2: Sam's UI Verification (manual)

The agent should produce a short list of spot-checks for Sam to verify in the Instantly UI. Structure it as:

### 2.1 Send count spot-check

Pick 3 campaigns from the 8am run's DISABLED entries (if any). For each, report:

| Campaign | Workspace | Step | Variant | CC Sent | CC Opps |
|----------|-----------|------|---------|---------|---------|

Sam will open each campaign in the Instantly UI and compare the step analytics numbers. **All should match within 1% tolerance.**

If no kills happened (all deferred or all healthy), pick 3 WARNING entries instead.

### 2.2 Kill verification spot-check

Pick 2 campaigns where variants were DISABLED. For each, report:
- Campaign name (exact, for UI search)
- Workspace name
- Step number
- Which variants should be OFF
- Which variants should be ON

Sam will verify the on/off state in the Instantly UI.

### 2.3 Campaigns that were skipped (DATA INTEGRITY SKIP)

List all campaigns that appeared in the 7pm run but not the 8am run (from query 1.3). For each:

| Campaign | Workspace | 7pm Sent (CC) | Why Skipped |
|----------|-----------|---------------|-------------|

Sam will spot-check 1-2 of these in the UI to confirm the sent count is indeed lower than what CC was reporting.

---

## Part 3: Final Report Template

After all checks, produce a summary in this format:

```
## 8am Test Run Audit Results — March 21, 2026

**Worker version:** [confirmed version, expect 0d78ca0]
**Run timestamp:** [UTC]
**Total kills:** X / 10 cap
**Total deferred:** X
**Total warnings:** X
**Total blocked:** X
**Errors:** X

### Fixes Verified
- [ ] **0 errors** (was 62/62 on 6am `a1cbf1c` run)
- [ ] Kill cap enforced (<=10 kills)
- [ ] Sanity check firing (X campaigns skipped)
- [ ] No premature kills on Alex Construction
- [ ] Grouped notification format correct
- [ ] Surviving variant count accurate
- [ ] LAST_VARIANT protection working

### Spot-Checks for Sam
[tables from Part 2]

### Issues Found
[any problems, or "None"]
```

---

## If something is wrong

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| errors > 0 | URL fix didn't work or new API issue | Check error count. If 62 again, the deploy didn't take. If partial, new issue. |
| worker_version != 0d78ca0 | Deploy didn't take or was overwritten | Re-deploy from correct commit |
| variants_disabled > 10 | Kill cap fix not in this version | Check if fa255ed includes the budget counter code |
| Alex Construction variants killed | Sanity check not firing | Check if the sanity check code is present in the deployed version |
| Inflated sent counts still matching 7pm numbers | Date filter or sanity check not deployed | Diff d6145dc against 87d06fa to see what actually changed |
| No grouped notifications (individual messages) | NotificationCollector not integrated | Check slack.ts for NotificationCollector class |
| LAST_VARIANT not blocking | Safety logic changed (should not have been) | Emergency: check evaluator.ts diff |
