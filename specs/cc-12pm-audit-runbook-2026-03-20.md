# Campaign Control 12pm ET Cron Audit Runbook

**Date:** 2026-03-20
**Cron Time:** 16:00 UTC (12:00 PM ET)
**Worker:** `auto-turnoff` (Cloudflare Workers, account `8eb4f67f852e00194242db7f998cb06b`)
**Worker Version:** `7b95a92` (git hash, deployed ~2026-03-20 20:00 UTC previous day's build cycle)
**Supabase Project:** `kczjvbbpwjrgbvomdawi` (campaign-control)
**KV Namespace:** `c054b62e43b54a22bcc1ffa24bb72272`

---

## Background: What Changed Since the 6pm Audit (2026-03-19)

The 6pm audit runbook (`cc-6pm-audit-runbook.md`) was written for the first successful direct API run after switching from MCP-based Instantly calls. Since then, **6 major changes** were deployed under version `7b95a92`:

### 1. Leads Monitoring: MCP Eliminated, Direct API Batch
- **Before:** Phase 3 (leads) used dual MCP calls per candidate (`countLeads()` + `getCampaignAnalytics()`), serialized over SSE. This crashed the 6am 2026-03-20 run mid-Phase-3 and stalled the worker.
- **After:** Leads check uses `getBatchCampaignAnalytics()` — one call per workspace returns all campaign analytics. O(1) lookups per candidate instead of O(N) serial MCP calls. MCP connection is now fully conditional (skipped in direct mode).

### 2. Disabled Variants: Skip Evaluation
- **Before:** Campaigns with all variants already disabled (e.g., PRESIDENTS NP in The Eagles) were evaluated every run, logging noisy BLOCKED entries with Infinity ratios.
- **After:** Two gates: (a) step-level skip if all variants disabled, (b) pre-kill check verifies variant isn't already disabled before API call. `safetyCheck()` now correctly counts only active variants as survivors.

### 3. Version Tagging: Git Hash per Deploy
- **Before:** All rows hardcoded `worker_version: 'v2'` across multiple deploys with different behavior.
- **After:** `deploy.sh` auto-generates `src/version.ts` with current git short hash. All Supabase writes use `7b95a92`. Query with `WHERE worker_version = '7b95a92'` for this deploy's data.

### 4. Step Indexing: 1-Indexed (Normalized)
- **Before:** Steps were 0-indexed in audit logs (CC step 0 = Instantly UI Step 1).
- **After:** Steps are 1-indexed everywhere. All historical v2 data was normalized by `cc-data-normalization` spec. Step numbers now match Instantly UI directly.

### 5. Per-Infrastructure Thresholds
- **Before:** Single `THRESHOLD = "4000"` env var.
- **After:** Thresholds resolved per provider: Google = 3,800, SMTP/OTD = 4,500, Outlook = 5,000. Product-level overrides: ERC = 6,000, S125 = 14,000. Fallback = 4,000 if tag list empty.

### 6. Expanded Workspace Fleet
- **Before:** 8-9 pilot workspaces.
- **After:** 17 workspaces processed (13 Funding, 2 ERC, 2 S125). Pilot CMs: ALEX, CARLOS, IDO, SAMUEL. Only their campaigns are evaluated.

### Other Changes
- **Kill cap:** `MAX_KILLS_PER_RUN = 10` prevents large initial purges. Excess candidates logged as `DEFERRED`.
- **Rescan/Redemption Window:** Killed variants rescanned after 4h, 48h redemption window for late-arriving opps.
- **Deployment:** Always via `./deploy.sh`, never raw `npx wrangler deploy`.

---

## 12pm Run Summary (Already Captured)

The 12pm run completed at 16:03:37 UTC. Here are the actual results from Supabase:

| Field | Actual Value | Notes |
|-------|-------------|-------|
| `worker_version` | `7b95a92` | Git hash, correct |
| `dry_run` | `false` | Real production run |
| `campaigns_evaluated` | 63 | Full fleet |
| `workspaces_processed` | 17 | All configured workspaces |
| `variants_blocked` | 164 | Variants exceeding threshold, protected by last-variant or kills paused |
| `variants_warned` | 9 | Approaching threshold (80%+) |
| `variants_disabled` | 0 | KILLS_ENABLED=false, expected |
| `leads_checked` | **0** | **INVESTIGATION NEEDED** (see Check 5) |
| `ghost_re_enables` | 0 | No external interference |
| `errors` | 0 | Clean run |
| `duration_ms` | 169,571 | 2.8 minutes — healthy |

**Comparison to earlier dry run (14:35 UTC):**

| Field | Dry Run (14:35 UTC) | Real Run (16:00 UTC) |
|-------|--------------------|--------------------|
| `campaigns_evaluated` | 63 | 63 |
| `variants_blocked` | 60 | 164 |
| `variants_warned` | 7 | 9 |
| `leads_checked` | 0 | 0 |
| `duration_ms` | 436,005 (7.3 min) | 169,571 (2.8 min) |

The dry run was significantly slower (7.3 min vs 2.8 min) and had fewer blocked variants. The blocked count difference (60 vs 164) suggests the dry-run path may skip some evaluation or the real run picks up additional variants from the Instantly API returning fresher data.

---

## Audit Scope

This runbook covers 8 checks. Checks 1-4 are already complete from the data pulled above. Checks 5-8 require investigation and Sam's manual verification.

---

## Check 1: Supabase -- run_summaries [COMPLETE]

**Status: PASS**

Run summary row confirmed:
- 1 row at `2026-03-20 16:03:36.996+00`
- Worker version `7b95a92`, dry_run false
- 63 campaigns across 17 workspaces in 169.6 seconds
- 0 errors, 0 ghost re-enables
- Duration well under the 5-minute ceiling (2.8 min)

**Verification SQL:**
```sql
SELECT timestamp, worker_version, dry_run, campaigns_evaluated,
  workspaces_processed, variants_blocked, variants_warned,
  variants_disabled, leads_checked, errors, duration_ms
FROM run_summaries
WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00'
ORDER BY timestamp DESC LIMIT 3;
```

---

## Check 2: Supabase -- daily_snapshots [COMPLETE]

**Status: PASS**

Snapshot for 2026-03-20 confirmed:

| Field | Value |
|-------|-------|
| `date` | 2026-03-20 |
| `total_campaigns` | 63 |
| `total_steps` | 272 |
| `total_variants` | 791 |
| `active_variants` | 517 |
| `disabled_variants` | 274 |
| `above_threshold` | 164 |
| `actions_disabled` | 0 |
| `actions_blocked` | 164 |
| `actions_warned` | 9 |
| `worker_version` | 7b95a92 |

**By Workspace:**

| Workspace | Total | Active | Disabled | Above Threshold |
|-----------|-------|--------|----------|----------------|
| Section 125 1 | 198 | 147 | 51 | 31 |
| The Dyad | 195 | 113 | 82 | 15 |
| Outlook 1 | 157 | 89 | 68 | 50 |
| Renaissance 1 | 118 | 90 | 28 | 41 |
| Renaissance 4 | 79 | 48 | 31 | 26 |
| Renaissance 5 | 24 | 14 | 10 | 0 |
| The Eagles | 20 | 16 | 4 | 1 |

**By CM:**

| CM | Total | Active | Disabled | Above Threshold |
|----|-------|--------|----------|----------------|
| IDO | 533 | 364 | 169 | 148 |
| CARLOS | 195 | 113 | 82 | 15 |
| ALEX | 43 | 24 | 19 | 0 |
| SAMUEL | 20 | 16 | 4 | 1 |

**Observation:** IDO has 148 variants above threshold (88% of all above-threshold variants). This is expected — he manages the most workspaces and campaigns. ALEX has 0 above threshold, so no notifications for Alex this run.

**Verification SQL:**
```sql
SELECT date, total_campaigns, total_steps, total_variants,
  active_variants, disabled_variants, above_threshold,
  actions_blocked, actions_warned, by_workspace, by_cm
FROM daily_snapshots
WHERE date = '2026-03-20'
ORDER BY created_at DESC LIMIT 1;
```

---

## Check 3: Supabase -- audit_logs [COMPLETE]

**Status: PASS**

| Action | Count | Notes |
|--------|-------|-------|
| `BLOCKED` | 164 | Variants exceeding threshold, last-variant protection or kills paused |
| `WARNING` | 9 | Approaching threshold (80%+ of per-infra threshold) |
| `DISABLED` | 0 | Expected: KILLS_ENABLED=false |

Total: 173 audit entries. Matches run_summary counts (164 blocked + 9 warned).

**Sample BLOCKED entries (Carlos / The Dyad):**

| Campaign | Step | Variant | Sent | Opps | Ratio | Threshold |
|----------|------|---------|------|------|-------|-----------|
| RG1219/.../Shops (CARLOS) | 1 | D | 26,740 | 6 | 4,457 | 3,800 |
| Qualify - Construction (CARLOS) | 4 | D | 4,607 | 1 | 4,607 | 3,800 |
| BrightFunds - Beauty Salons | 1 | D | 18,002 | 4 | 4,501 | 3,800 |
| Pair 2 - Clothing | 4 | B | 5,091 | 0 | Infinity | 3,800 |

**Sample BLOCKED entries (Ido / Outlook 1):**

| Campaign | Step | Variant | Sent | Opps | Ratio | Threshold |
|----------|------|---------|------|------|-------|-----------|
| Advertising - Google + Others | 4 | B | 8,625 | 1 | 8,625 | 5,000 |
| Construction - Google + Others | 1 | C | 50,015 | 9 | 5,557 | 5,000 |
| Advertising - Google + Others | 2 | A | 50,593 | 9 | 5,621 | 5,000 |

**Key observations:**
1. Per-infrastructure thresholds working: The Dyad (Google-heavy) uses 3,800, Outlook 1 uses 5,000.
2. Some variants have massive sent counts (50K+) with few opps — these reflect the opp vs possibility classification problem. Real interested leads may be tagged "possibility" not "opportunity."
3. `safety_surviving_variants = 0` on many entries means these are last-variant-protected (can't be killed without orphaning the step).
4. `Infinity` ratios appear on 0-opportunity variants (division by zero), correctly handled.

**Verification SQL:**
```sql
SELECT action, COUNT(*) AS count
FROM audit_logs
WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00'
GROUP BY action ORDER BY count DESC;
```

---

## Check 4: Supabase -- notifications [COMPLETE]

**Status: PASS**

9 WARNING notifications, all delivered successfully:

| # | Channel | CM | Workspace | Campaign | Step | Variant | % of Threshold | Opps |
|---|---------|----|-----------|---------|----|---------|---------------|------|
| 1 | #cc-ido | IDO | Renaissance 1 | RG2161/2162/2163/2164 RG 2289 - Construction | 5 | A | 97.8% | 3 |
| 2 | #cc-ido | IDO | Renaissance 1 | RG2161/2162/2163/2164 RG 2289 - Construction | 5 | B | 97.7% | 4 |
| 3 | #cc-ido | IDO | Renaissance 1 | RG2161/2162/2163/2164 RG 2289 - Construction | 5 | C | 97.7% | 0 |
| 4 | #cc-carlos | CARLOS | The Dyad | RG858/859/860/861 - Elevate Growth - Law Firms | 4 | C | 84.9% | 1 |
| 5 | #cc-carlos | CARLOS | The Dyad | RG858/859/860/861 - Elevate Growth - Law Firms | 4 | D | 84.8% | 1 |
| 6 | #cc-ido | IDO | Outlook 1 | Restaurants - B42.2O - Google + Others | 4 | C | 83% | 0 |
| 7 | #cc-ido | IDO | Outlook 1 | Restaurants - B42.2O - Google + Others | 4 | D | 83% | 1 |
| 8 | #cc-ido | IDO | Outlook 1 | Restaurants - B42.2O - Google + Others | 4 | E | 83% | 0 |
| 9 | #cc-ido | IDO | Outlook 1 | Restaurants - B42.2O - Google + Others | 4 | F | 82.9% | 0 |

**All 9 notifications:**
- `reply_success = true` (thread reply posted successfully)
- `thread_ts` non-null (title message created)
- Correct channel routing (Ido -> #cc-ido, Carlos -> #cc-carlos)
- No fallback to #cc-general needed

**Slack verification (confirmed):**
- #cc-ido: 7 messages at 16:01 UTC, all threaded with detail replies
- #cc-carlos: 2 messages at 16:01 UTC, all threaded with detail replies
- #cc-alex: No messages from 12pm run (expected: ALEX has 0 above-threshold)
- #cc-samuel: No messages from 12pm run (expected: SAMUEL has 1 above-threshold but below warning %)
- #cc-general: No fallback messages (correct)

**Thread format verified (sample from #cc-ido):**
```
Title: :eyes: Early Warning: Variant A approaching threshold (97.8%)
Reply:
  Workspace: Renaissance 1
  Campaign: RG2161, RG2162, RG2163, RG2164 RG 2289- Construction
  Step 5, Variant A

  Emails sent: 3,718 / 3,800 (97.8% of auto-disable threshold)
  Opportunities: 3

  This variant will be auto-disabled when it hits 3,800 sends with insufficient opportunities.
```

Note: The threshold shown in the message is 3,800 (Google provider threshold), confirming per-infrastructure thresholds are working in notifications.

---

## Check 5: Supabase -- leads_audit_logs [BUG FOUND AND FIXED]

**Status: FAIL -- Root cause identified, fix applied**

No `leads_audit_logs` entries exist for the 12pm run. `leads_checked = 0` in run_summaries.

### Root Cause

**File:** `src/instantly-direct.ts`, line 245

`getBatchCampaignAnalytics()` reads `c.id` but the Instantly v2 API returns `campaign_id`:

```typescript
// BEFORE (broken):
const id = c.id as string;       // undefined — API field is "campaign_id"
if (!id) continue;                // Every campaign silently skipped

// AFTER (fixed):
const id = (c.campaign_id ?? c.id) as string;
```

Every campaign in the batch response was skipped because `c.id` was always `undefined`. The leads candidate loop found no matching data, skipped all candidates with `console.warn`, and `leads_checked` never incremented.

### Fix Applied

`instantly-direct.ts` line 245 patched: `c.id` -> `(c.campaign_id ?? c.id)`. Comment on line 242 also corrected to reflect the actual API response shape (bare array, not `{ campaigns: [...] }`).

**Needs redeploy via `./deploy.sh` to take effect.**

---

## Check 6: KV State [COMPLETE]

**Status: PASS**

| Key | Result | Status |
|-----|--------|--------|
| `run:2026-03-20T16:03:36.996Z` | Present | PASS |
| `snapshot:2026-03-20` | Present (expires 2026-06-18) | PASS |
| `heartbeat` | `2026-03-20T16:02:22.747Z`, 40 campaigns at heartbeat write | PASS |
| `auto-turnoff-lock` | Absent (released correctly) | PASS |
| `leads:*` dedup keys | None — rules out dedup as cause for leads_checked=0 | PASS (confirms bug is in code, not dedup) |
| Total keys | 83,392 | PASS (healthy, up from 20K) |

---

## Check 7: Slack Channel Cross-Verification [COMPLETE]

**Status: PASS**

All 9 Slack notifications verified against Supabase `notifications` table:

### #cc-ido (C0AMRK842PK) -- 7 messages

| Time (UTC) | Title | Thread Verified |
|-----------|-------|----------------|
| 16:01:06 | Variant A approaching threshold (97.8%) | Yes - Renaissance 1, Construction, Step 5 |
| 16:01:09 | Variant B approaching threshold (97.7%) | Yes - Renaissance 1, Construction, Step 5 |
| 16:01:12 | Variant C approaching threshold (97.7%) | Yes - Renaissance 1, Construction, Step 5 |
| 16:01:49 | Variant C approaching threshold (83%) | Yes - Outlook 1, Restaurants, Step 4 |
| 16:01:52 | Variant D approaching threshold (83%) | Yes - Outlook 1, Restaurants, Step 4 |
| 16:01:54 | Variant E approaching threshold (83%) | Yes - Outlook 1, Restaurants, Step 4 |
| 16:01:57 | Variant F approaching threshold (82.9%) | Yes - Outlook 1, Restaurants, Step 4 |

### #cc-carlos (C0AMRK81MRP) -- 2 messages

| Time (UTC) | Title | Thread Verified |
|-----------|-------|----------------|
| 16:01:22 | Variant C approaching threshold (84.9%) | Yes - The Dyad, Elevate Growth Law Firms, Step 4 |
| 16:01:24 | Variant D approaching threshold (84.8%) | Yes - The Dyad, Elevate Growth Law Firms, Step 4 |

### #cc-alex (C0AN70F328G) -- 0 messages from 12pm run
Expected: ALEX has 0 above-threshold variants in snapshot.

### #cc-samuel (C0AMCMVLVDG) -- 0 messages from 12pm run
Expected: SAMUEL has 1 above-threshold variant but below warning percentage.

### #cc-general (C0AMRK8RC4R) -- 0 messages
Expected: No fallback routing needed.

**All messages are:**
- Threaded (title + reply, not two separate top-level messages)
- No duplicates for the same variant
- `thread_ts` in Supabase matches Slack message timestamps
- Per-infrastructure thresholds displayed correctly (3,800 for Google, 5,000 for Outlook)

---

## Check 8: Data Accuracy Spot-Checks [COMPLETE]

**Status: PASS (variant analytics) / CONFIRMED BUG (leads)**

### Variant Step Analytics -- 6/6 Opportunity Counts Exact Match

| # | Workspace (CM) | Campaign | Step | Var | CC Sent | UI Sent | Sent Delta | CC Opps | UI Opps | Opps Match? |
|---|----------------|----------|------|-----|---------|---------|------------|---------|---------|-------------|
| 1 | Renaissance 1 (Ido) | RG2161...Construction | 5 | A | 3,718 | 4,029 | +311 | 3 | 3 | **Yes** |
| 2 | The Dyad (Carlos) | Elevate Growth Law Firms | 4 | C | 3,821 | 3,394 | -427 | 1 | 1 | **Yes** |
| 3 | Outlook 1 (Ido) | Restaurants B42.2O | 4 | D | 4,148 | 3,744 | -404 | 1 | 1 | **Yes** |
| 4 | The Dyad (Carlos) | Pair 2 Clothing | 4 | B | 5,091 | 5,091 | 0 | 0 | 0 | **Yes** |
| 5 | Outlook 1 (Ido) | Construction Google+ | 1 | C | 50,015 | 50,015 | 0 | 9 | 9 | **Yes** |
| 6 | The Dyad (Carlos) | Pair 1 Construction | 3 | C | 5,753 | 5,753 | 0 | 1 | 1 | **Yes** |

**Opportunities: 6/6 exact match.** This is the metric that drives kill decisions -- clean.

**Sent count observations:**
- 3 exact matches (#4, #5, #6)
- 1 expected positive drift (#1: +311, 27 min of additional sends between run and UI check)
- 2 unexpected negative deltas (#2: -427, #3: -404) where CC reported MORE sent than UI shows. Not a blocker since opps are correct. May be an Instantly UI caching quirk or step analytics API aggregating slightly differently than the UI view. Worth monitoring.

### Leads Spot-Check -- Confirms Bug

| # | Workspace (CM) | Campaign | CC Total | UI Total | UI Seq Started | UI Uncontacted |
|---|----------------|----------|----------|----------|---------------|----------------|
| 7 | The Dyad (Carlos) | Pair 1 Construction Summit Bridge | 21,676 | 21,676 | 19,192 | ~2,484 |

CC total matches. Campaign has ~2,484 uncontacted leads (21,676 - 19,192). The 12pm run should have evaluated this but `leads_checked = 0` due to the `campaign_id` field mismatch bug in `getBatchCampaignAnalytics()` (see Check 5).

---

## Findings Summary

### Passed (7/8 checks)

| Check | Status |
|-------|--------|
| 1. run_summaries | PASS - 63 campaigns, 17 workspaces, 0 errors, 2.8 min |
| 2. daily_snapshots | PASS - Full snapshot with correct variant counts |
| 3. audit_logs | PASS - 164 BLOCKED + 9 WARNING, matches run_summary |
| 4. notifications | PASS - 9 warnings, all delivered, correct channels |
| 6. KV State | PASS - Run key, snapshot, heartbeat present; lock released; no stale leads dedup keys |
| 7. Slack cross-verification | PASS - All 9 messages verified in correct channels with threads |
| 8. Data accuracy (variants) | PASS - 6/6 opportunity counts exact match against Instantly UI |

### Failed (1/8) -- Bug Found and Fixed

| Check | Status | Root Cause | Fix |
|-------|--------|-----------|-----|
| 5. leads_audit_logs | FAIL | `getBatchCampaignAnalytics()` reads `c.id` but API returns `campaign_id` -- every campaign silently skipped | `instantly-direct.ts:245` patched: `c.id` -> `(c.campaign_id ?? c.id)`. **Needs redeploy.** |

---

## Red Flags Summary

| Symptom | Status | Notes |
|---------|--------|-------|
| `leads_checked = 0` | **RESOLVED** | Root cause: `campaign_id` vs `c.id` field mismatch. Fix applied, needs redeploy. |
| Sent count negative deltas (#2, #3) | **MONITOR** | CC reported more sent than UI shows (-427, -404). Opps correct. May be Instantly UI caching. Watch next run. |
| `variants_blocked` 60 (dry) vs 164 (real) | **LOW** | Dry-run path may evaluate differently or analytics data refreshed between runs. |
| High Infinity-ratio variants | **KNOWN** | Opp vs possibility classification problem. Blocked on Daniel/Grace conversation. |
| 274 disabled variants (35% of fleet) | **EXPECTED** | Historical kills from pre-KILLS_ENABLED=false era. |

---

## Post-Audit Next Steps

### Immediate: Redeploy with leads fix
The `campaign_id` fix in `instantly-direct.ts` needs to be deployed:
```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
./deploy.sh
```
Then verify leads phase works on the next cron run (6pm ET = 22:00 UTC or next day 6am ET = 10:00 UTC).

### After leads fix verified:
1. Resolve the opportunity vs possibility classification problem (gate for KILLS_ENABLED=true)
2. Monitor 2-3 more cron cycles to confirm full stability
3. When ready: flip `KILLS_ENABLED=true` in wrangler.toml and deploy via `./deploy.sh`

---

## Quick Reference: SQL Queries

```sql
-- 1. Run summary
SELECT timestamp, worker_version, dry_run, campaigns_evaluated, workspaces_processed,
  variants_blocked, variants_warned, variants_disabled, leads_checked, errors, duration_ms
FROM run_summaries WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00' ORDER BY timestamp DESC LIMIT 3;

-- 2. Audit log counts
SELECT action, COUNT(*) FROM audit_logs WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00' GROUP BY action ORDER BY count DESC;

-- 3. Spot-check candidates
SELECT campaign, workspace, cm, step, variant_label,
  trigger_sent, trigger_opportunities, trigger_ratio, trigger_threshold, action
FROM audit_logs WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00'
  AND action IN ('BLOCKED', 'WARNING')
ORDER BY cm, workspace, action LIMIT 20;

-- 4. Notifications
SELECT notification_type, COUNT(*), COUNT(CASE WHEN reply_success THEN 1 END) AS ok,
  COUNT(CASE WHEN thread_ts IS NOT NULL THEN 1 END) AS threaded
FROM notifications WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00'
GROUP BY notification_type ORDER BY count DESC;

-- 5. Daily snapshot
SELECT date, total_campaigns, total_variants, active_variants, disabled_variants,
  above_threshold, actions_blocked, actions_warned
FROM daily_snapshots WHERE date = '2026-03-20' ORDER BY created_at DESC LIMIT 1;

-- 6. Leads audit
SELECT action, COUNT(*) FROM leads_audit_logs WHERE worker_version = '7b95a92'
  AND timestamp > '2026-03-20 16:00:00+00' GROUP BY action;

-- 7. Compare all runs today
SELECT timestamp, worker_version, dry_run, campaigns_evaluated, variants_blocked,
  variants_warned, leads_checked, errors, duration_ms
FROM run_summaries WHERE timestamp > '2026-03-20 00:00:00+00' ORDER BY timestamp;
```

---

## Quick Reference: KV Commands

```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
NS="c054b62e43b54a22bcc1ffa24bb72272"

npx wrangler kv key list --namespace-id $NS --remote --prefix "run:" 2>/dev/null | grep "2026-03-20T16"
npx wrangler kv key list --namespace-id $NS --remote --prefix "snapshot:2026-03-20" 2>/dev/null
npx wrangler kv key get heartbeat --namespace-id $NS --remote 2>/dev/null
npx wrangler kv key list --namespace-id $NS --remote --prefix "auto-turnoff-lock" 2>/dev/null
npx wrangler kv key list --namespace-id $NS --remote --prefix "leads:" 2>/dev/null | head -20
npx wrangler kv key list --namespace-id $NS --remote 2>/dev/null | wc -l
```

---

## Quick Reference: Wrangler Tail

```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
npx wrangler tail auto-turnoff --format json
```

Look for structured log events:
- `run_start` — cron trigger fired
- `workspace_complete` — each workspace processed
- `phase_start` with `phase: 'rescan'` — Phase 3 (rescan) starting
- `phase_start` with `phase: 'leads'` — Phase 4 (leads) starting
- `phase_start` with `phase: 'snapshot'` — Phase 6 (snapshot) starting
- `run_complete` — entire run finished

---

## Slack Channel Reference

| CM | Channel | Channel ID | 12pm Messages |
|----|---------|-----------|---------------|
| Alex | #cc-alex | C0AN70F328G | 0 |
| Carlos | #cc-carlos | C0AMRK81MRP | 2 |
| Ido | #cc-ido | C0AMRK842PK | 7 |
| Samuel | #cc-samuel | C0AMCMVLVDG | 0 |
| General | #cc-general | C0AMRK8RC4R | 0 |
