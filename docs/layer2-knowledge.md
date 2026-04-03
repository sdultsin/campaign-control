# CC Layer 2 Audit - Reference Document
**[2026-03-24]** This file is the authoritative reference for the Campaign Control Layer 2 audit system. It contains the Bug Class Registry, Known Noise Patterns, and the Classification Decision Tree used by the Layer 2 audit agent to triage findings.

---

# Section 1: Bug Class Registry

### 1. Dashboard Write Gap (c90bbb5 -> 2c3a98b)
- **Symptoms:** audit_logs had DISABLED entries but dashboard_items didn't have matching rows for real (non-dry-run) kills
- **Root cause:** In `index.ts`, real kills were being executed but only `dryRunKills` array was passed to `buildDashboardState()`. The `dryRunKills` array was populated for dry-run CMs only. Real kills (DRY_RUN_CMS empty set) were never added to this array, so the dashboard write that depended on it was skipped entirely.
- **Investigation path:** Compare audit_logs (action=DISABLED, dry_run=false) against dashboard_items (item_type=DISABLED) for same campaign_id + step + variant. Missing dashboard rows = write gap. Query: `SELECT al.campaign_id, al.step, al.variant FROM audit_logs al LEFT JOIN dashboard_items di ON al.campaign_id = di.campaign_id AND al.step = di.step AND al.variant = di.variant AND di.item_type = 'DISABLED' AND di.resolved_at IS NULL WHERE al.action = 'DISABLED' AND al.dry_run = false AND di.id IS NULL`
- **Files involved:** `src/index.ts` (buildDashboardState call, ~line 1400), `src/dashboard-state.ts` (buildDashboardState function, dryRunKills parameter)
- **How it was detected:** Manual audit of 6am run comparing audit_log kill count vs dashboard_items DISABLED count

### 1b. Dashboard Resolve Gap (variant of #1)
- **Symptoms:** DISABLED and STEP_FROZEN dashboard_items created correctly but resolved_at set on the very next run (4-10 minutes later). All permanent action items disappear from the CM dashboard within one scan cycle.
- **Root cause:** `resolveStaleItems()` in `supabase.ts` iterates all active (unresolved) dashboard_items for a CM and resolves any whose key is not in the current run's `activeKeys` set. DISABLED items from prior runs are never in `activeKeys` because the variant is already disabled in Instantly and won't be re-evaluated/re-killed. Same applies to STEP_FROZEN items. So permanent action records get auto-resolved by the next run.
- **Investigation path:** Query: `SELECT id, item_type, created_at, resolved_at FROM dashboard_items WHERE item_type IN ('DISABLED', 'STEP_FROZEN') AND resolved_at IS NOT NULL AND resolved_at - created_at < interval '1 hour' AND worker_version = 'v2'`. Short-lived DISABLED/STEP_FROZEN items indicate this bug.
- **Files involved:** `src/supabase.ts` (resolveStaleItems ~line 298), `src/dashboard-state.ts` (buildDashboardState - activeKeys population)
- **Fix:** Added `PERMANENT_ITEM_TYPES` set (`DISABLED`, `STEP_FROZEN`) checked at the top of the resolve loop. Permanent items are skipped entirely by auto-resolve; only explicit CM dismissal clears them.
- **How it was detected:** 4 kills at 13:37-13:40 UTC created dashboard_items at 13:42. Next run at 13:43 resolved all 4 at 13:47:58 because activeKeys for DISABLED was empty.
- **Bug class pattern:** **Permanent action items treated as transient conditions.** Any dashboard item type that represents a one-time action (not a recurring condition) must be excluded from auto-resolve. Transient types (BLOCKED, APPROACHING, LEADS_WARNING, LEADS_EXHAUSTED, WINNING) are correctly auto-resolved because they are re-detected every run while the condition persists.

### 2. Variant Dedup Failure (c90bbb5 -> 248cba1, deployed in 2c3a98b)
- **Symptoms:** Multiple dashboard_items for same campaign/step with different variants were colliding. When 2+ variants in the same step were both winners, only one row was stored. Second variant's context data overwrote the first, but variant and variant_label fields were not updated. Row showed first variant's label with last variant's numbers.
- **Root cause:** Three layers enforced one-row-per-step without considering variant: (1) Unique index on dashboard_items: `(cm, campaign_id, item_type, COALESCE(step, -1))` - no variant column (2) Upsert match in `supabase.ts` `upsertDashboardItem()`: queried by (cm, campaign_id, item_type, step) - no variant filter (3) Active keys in `dashboard-state.ts` `addIssue()`: key format was `${campaign_id}:${item_type}:${step}` - no variant (4) Resolve keys in `supabase.ts` `resolveStaleItems()`: same key format - no variant
- **Investigation path:** Query dashboard_items: `SELECT cm, campaign_id, item_type, step, COUNT(*) FROM dashboard_items WHERE resolved_at IS NULL GROUP BY cm, campaign_id, item_type, step HAVING COUNT(*) > 1`. Also check if any WINNING rows have variant_label that doesn't match the context data.
- **Files involved:** `src/supabase.ts` (upsertDashboardItem upsert match ~line 188-210, resolveStaleItems key ~line 266), `src/dashboard-state.ts` (addIssue active key ~line 49-51)
- **How it was detected:** Manual audit found Construction 2 - Outlook Step 1 showed "Var A" label with Var B's opportunity count

### 3. Ghost Write Failure (2c3a98b -> d7a5055)
- **Symptoms:** run_summaries.ghost_re_enables > 0 but zero GHOST_REENABLE rows in audit_logs. ghost_details column was null. Exempt KV keys were not written.
- **Root cause:** In `index.ts` (~line 2263-2264), the ghost detection phase had `.catch(() => {})` on both KV and Supabase writes, silently swallowing all errors. The actual error was likely a schema mismatch or null reference in the ghostAudit object being passed to `writeAuditLogToSupabase`. Additionally, the run_summaries table lacked a `ghost_details` column, and no ghost detail collection existed in the code.
- **Investigation path:** Check run_summaries: `SELECT ghost_re_enables, ghost_details FROM run_summaries WHERE ghost_re_enables > 0 AND worker_version = 'v2' ORDER BY timestamp DESC`. If ghost_details IS NULL when ghost_re_enables > 0, the write failure persists. Also check KV for exempt keys: `exempt:<campaignId>:<step>:<variant>`.
- **Files involved:** `src/index.ts` (ghost detection phase ~line 2250-2270), `src/supabase.ts` (writeRunSummaryToSupabase - ghost_details field)
- **How it was detected:** 6am run audit showed 3 ghost re-enables in run_summary but no audit trail

### 4. API URL Regression (87d06fa -> 0d78ca0)
- **Symptoms:** 62/62 errors on getCampaignAnalytics. All campaign evaluations failed. errors array in run_summaries filled with HTTP error messages.
- **Root cause:** Instantly API v2 changed from path params to query params for campaign analytics endpoint. The old code used `/campaigns/{id}/analytics` but v2 expects `/campaigns/analytics?campaign_id={id}`.
- **Investigation path:** Check run_summaries errors array: `SELECT errors FROM run_summaries WHERE worker_version = 'v2' ORDER BY timestamp DESC LIMIT 5`. Parse error messages for HTTP status codes (400/404) and endpoint URLs. Consistent failure across all campaigns indicates an API contract change.
- **Files involved:** `src/instantly-direct.ts` (getStepAnalytics, getCampaignAnalytics methods - uses `/campaigns/analytics` with query params)
- **How it was detected:** Run summary showed 100% error rate across all campaigns

### 5. Kill Cap Breach (pre-1802bf2)
- **Symptoms:** More than MAX_KILLS_PER_RUN (10) variants disabled in a single run
- **Root cause:** Kill counter was tracked globally across all workspaces and CMs. When multiple CMs had kill candidates in the same run, the total could exceed the per-run cap even though the intent was to limit blast radius. The fix was to enforce the cap as a hard global limit: once 10 kills are reached, remaining candidates are logged as DEFERRED.
- **Investigation path:** Count DISABLED audit_log entries per run: `SELECT DATE_TRUNC('hour', timestamp) as run, COUNT(*) as kills FROM audit_logs WHERE action = 'DISABLED' AND worker_version = 'v2' GROUP BY 1 HAVING COUNT(*) > 10`. Compare against MAX_KILLS_PER_RUN (currently 10 in config.ts).
- **Files involved:** `src/index.ts` (kill budget logic, killBudgetRemaining counter), `src/config.ts` (MAX_KILLS_PER_RUN = 10)
- **How it was detected:** Post-run audit found more kills than the configured cap

### 6. Lead Count Accumulator (pre-1802bf2)
- **Symptoms:** contacted_count in leads checks was wildly high compared to Instantly UI. Leads monitoring fired false LEADS_EXHAUSTED and LEADS_WARNING alerts.
- **Root cause:** The Instantly API field `contacted_count` is a lifetime accumulator - it includes all leads that have ever been contacted (including bounced, completed, and unsubscribed). It is NOT the current active-in-sequence count. Using it as "how many leads have been sent to" dramatically inflated the denominator, making campaigns appear to have far more sent leads than they actually had active.
- **Investigation path:** If leads_check_errors spike or leads numbers seem inflated, compare the API's `contacted_count` against `active` (currently in sequence). The leads monitor now uses `leads_count`, `contacted_count`, `completed_count`, `bounced_count`, `unsubscribed_count` from the batch analytics endpoint to compute accurate active count.
- **Files involved:** `src/leads-monitor.ts` (evaluateLeadDepletion), `src/instantly-direct.ts` (getBatchCampaignAnalytics - returns all count fields)
- **How it was detected:** Leads monitoring alerts didn't match what CMs saw in Instantly UI

### 7. Ghost Audit Index Mismatch (d7a5055 -> [pending])
- **Symptoms:** self-audit ghost_audit check FAIL reporting missing exempt KV keys (e.g. `exempt:<id>:1:3`), but KV actually contains the key at `exempt:<id>:0:3`. The exempt key exists; the lookup constructs the wrong key.
- **Root cause:** `ghost_details` in run_summaries stores `step: kill.stepIndex + 1` (1-based, for display). The self-audit `checkGhostAudit` used `ghost.step` directly to construct the exempt KV key, but exempt keys are written with the 0-based `kill.stepIndex`. Result: audit looked up `exempt:<id>:1:<var>` when the actual key was `exempt:<id>:0:<var>`.
- **Bug class pattern:** **1-based display values used in 0-based lookups.** Any time a value is stored with +1 for human display, downstream code that uses it for system lookups (KV keys, API calls, array indices) must subtract 1. Audit checks are especially vulnerable because they reconstruct keys from display-oriented data.
- **Investigation path:** If ghost_audit FAIL shows "missing exempt keys", compare the step number in the missing key against KV. If `exempt:<id>:<N>:<var>` is missing but `exempt:<id>:<N-1>:<var>` exists, this is the index mismatch. Query: check `audit_results` for `ghost_audit` FAIL entries and parse the `details` field for the constructed key.
- **Files involved:** `src/self-audit.ts` (checkGhostAudit ~line 256, exempt key construction), `src/index.ts` (~line 2270 ghost_details step assignment, ~line 2316 exempt key write)
- **How it was detected:** Layer 2 audit found ghost_audit FAIL with `missing exempt:...:1:3` while kv_summary showed `exempt_keys=1` at the 0-based index

---

# Section 2: Known Noise Patterns

### Equal Distribution Kills
**Pattern:** All variants in a campaign have ~equal sent counts and 0 opportunities. System kills the first N variants (alphabetical or by variant index).
**Why it's noise:** Campaign hasn't matured enough for any variant to differentiate. Kills are technically correct (0 opps above threshold) but not meaningful signal.
**Classification:** NOISE
**Slack note:** "Equal distribution kill in [campaign] - campaign too young to differentiate variants."

### Redemption Re-kill
**Pattern:** Same variant appears as DISABLED in two consecutive runs, with a RE_ENABLED or RESCAN_RE_ENABLED audit_log entry between the two DISABLED entries.
**Why it's noise:** Phase 2 (Redemption Window) auto-re-enabled the variant because late-arriving opportunities improved the opp/sent ratio past the recovery threshold. The next run re-evaluated the variant and killed it again because performance still fell below threshold after the grace period. This is the system working correctly - the variant got a fair second look and failed.
**Classification:** EXPECTED_BEHAVIOR
**Investigation path:** Query audit_logs for RE_ENABLED or RESCAN_RE_ENABLED actions for the same (campaign_id, step, variant) between the timestamps of the two DISABLED entries. If found, this is Redemption Re-kill.
**Slack note:** "[N] variants re-killed after Redemption Window re-enable. Expected behavior."

### Deploy Re-evaluation
**Pattern:** Same variant appears as DISABLED in two consecutive runs, but worker_version differs between the two DISABLED audit_log entries.
**Why it's noise:** A deploy between runs cleared the KV kill dedup keys (key pattern: `kill:{campaignId}:{variant}`). The variant was re-evaluated from scratch and killed again because it still failed threshold. Not a CM action and not a code bug - the 7-day dedup key was wiped by the KV clear that accompanies some deploy types.
**Classification:** NOISE
**Investigation path:** Compare worker_version on the two DISABLED audit_log rows for the same variant. If they differ, this is Deploy Re-evaluation. Cross-reference the deploy timestamp against the gap between the two kills.
**Slack note:** "[N] re-kills after deploy KV wipe. Dedup keys cleared. Not a system bug."

### CM Re-enabling Killed Variants
**Pattern:** Same variant appears as DISABLED in two consecutive runs, with NO RE_ENABLED/RESCAN_RE_ENABLED audit_log between the kills AND the same worker_version on both DISABLED entries.
**Why it's noise:** CM behavior, not a CC bug. CM re-enabled the variant after CC killed it - possibly because they added new leads, changed copy, or disagreed with the kill. Ghost detection (Phase 4) handles this by writing exempt keys on the next run.
**Classification:** CM_BEHAVIOR
**IMPORTANT - check system causes first:** Before classifying any repeat kill as CM_BEHAVIOR, rule out Redemption Re-kill (check for RE_ENABLED audit_log between kills) and Deploy Re-evaluation (check worker_version on both DISABLED rows). Only if neither applies is this CM_BEHAVIOR.
**Slack note:** "[CM] re-enabled [N] killed variants. Not a system issue."

### Expansion Surge
**Pattern:** Kills, blocks, and campaign counts spike after new CMs are added to PILOT_CMS in config.ts.
**Why it's noise:** New campaigns being evaluated for the first time. Mature campaigns with poor variants get killed on first pass. Expected for 2-3 runs after onboarding.
**Classification:** NOISE
**Slack note:** "[N] new CMs onboarded. Elevated kills expected for 2-3 runs."

### Last-Variant Protection
**Pattern:** A variant is below threshold but shows as BLOCKED instead of DISABLED in audit_logs.
**Why it's noise:** It's the last active variant in the campaign. safetyCheck() in evaluator.ts returns canKill=false when remaining active variants would be 0. CC protects it by design to prevent emptying a campaign step.
**Classification:** EXPECTED_BEHAVIOR

### OFF Campaign Buffer
**Pattern:** Campaign with "OFF" prefix in name has a higher effective threshold than expected.
**Why it's noise:** OFF campaigns get a 20% threshold extension (OFF_CAMPAIGN_BUFFER = 1.2 in config.ts). resolveThreshold() in thresholds.ts applies this multiplier. By design - OFF campaigns get more runway before kill.
**Classification:** EXPECTED_BEHAVIOR

### Workspace Count Fluctuation
**Pattern:** workspaces_processed varies by 1-2 between runs, or consistently shows 17/18.
**Why it's noise:** The worker processes only WORKSPACE_CONFIGS entries that have valid API keys in the INSTANTLY_API_KEYS secret. If a workspace key is missing, that workspace is filtered out at listWorkspaces() (instantly-direct.ts:104-109). 17/18 is expected when one workspace has no API key available. API timeouts on one workspace don't affect others.
**Classification:** NOISE

### Slack Suppression False Positives
**Pattern:** slack_delivery check reports 10-17 failed notifications per run. All have reply_success = false.
**Why it's noise:** Since c6a99c7 (CM Supervision Console deploy), per-item Slack notifications are intentionally suppressed. index.ts passes skipSlack = true. Notifications still write to Supabase with reply_success = false but never call the Slack API. The slack_delivery self-audit check (self-audit.ts:441) counts all reply_success = false rows without distinguishing intentional suppression from real failures.
**Classification:** EXPECTED_BEHAVIOR

### KV API Auth Errors
**Pattern:** Layer 2 investigation reports KV API authentication failure (error 10000) or similar Cloudflare REST API errors when inspecting KV state.
**Why it's noise:** Layer 2 is Supabase-only by design. All KV state is available in the kv_summary field of audit_results. Layer 2 should NEVER call the Cloudflare KV REST API directly. If this error appears, Layer 2 violated its own rules - the data it needs is already in Supabase.
**Classification:** NOISE
**Slack note:** "L2 attempted direct KV API call - not needed, kv_summary in audit_results has the data."

### Digest-Only Run
**Pattern:** run_summaries row with campaigns_evaluated = 0 at 12:00 UTC (8am ET).
**Why it's noise:** The 8am ET run is digest-only (CRON_HOURS_UTC = [10, 16, 22] for eval runs; 12:00 UTC is excluded). sendMorningDigest() runs instead of the evaluation pipeline. Expected behavior.
**Classification:** EXPECTED_BEHAVIOR

---

# Section 3: Classification Decision Tree

## Classification Flow

For each finding from the analysis steps:

1. Does this match a Known Noise Pattern (Section 2)?
   YES -> Classify accordingly (NOISE, CM_BEHAVIOR, or EXPECTED_BEHAVIOR), produce NOTE, move on
   NO -> Continue

2. Is the data in audit_logs/run_summaries consistent with what the CC code should produce given the Instantly API data?
   YES -> Not a CC code bug. Classify as:
     - API_ISSUE: Instantly returned unexpected data (stale analytics, missing campaigns, malformed step data)
     - CM_BEHAVIOR: CM action explains the pattern (re-enables, campaign config changes, new leads added)
       SUB-CHECK for repeat kills before assigning CM_BEHAVIOR: If the same variant was killed in two consecutive runs, check for system-caused re-enables before attributing to CM action.
         1. Query audit_logs for RE_ENABLED or RESCAN_RE_ENABLED actions for that (campaign_id, step, variant) between the two DISABLED timestamps. If found -> EXPECTED_BEHAVIOR (Redemption Re-kill), not CM_BEHAVIOR.
         2. Compare worker_version on both DISABLED audit_log rows. If they differ -> NOISE (Deploy Re-evaluation), not CM_BEHAVIOR.
         3. Only if NEITHER applies -> CM_BEHAVIOR.
       See Section 2 noise patterns: "Redemption Re-kill" and "Deploy Re-evaluation".
     - INFRA: Environment issue (Cloudflare Worker timeout, Supabase connection failure, Slack API error, KV rate limit)
   NO -> CC code bug. Proceed to full investigation.

3. For CC code bugs, does it match a Bug Class Registry entry (Section 1)?
   YES -> Use that entry's investigation path. Check the fix version commit hash.
         If fix IS deployed and bug recurred -> regression. CRITICAL priority.
         If fix is NOT deployed -> known open issue. NOTE with version info.
   NO -> New bug class. Full investigation required. Trace the code path through:
         - src/evaluator.ts for kill/block decision logic
         - src/thresholds.ts for threshold resolution
         - src/index.ts for execution flow
         - src/dashboard-state.ts for dashboard writes
         - src/supabase.ts for data persistence
         - src/self-audit.ts for audit check implementations

4. Severity assignment:
   - CRITICAL: Incorrect kills (variant killed when it shouldn't be), data loss (writes silently failing), regression of a fixed bug
   - WARNING: Missing data (ghost_details null), threshold miscalculation that hasn't caused incorrect kills yet, leads monitoring false alerts
   - INFO: Dashboard display issues, notification delivery failures, KV key staleness
