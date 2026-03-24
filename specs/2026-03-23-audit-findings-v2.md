# Campaign Control - Deep Technical Audit V2

**Date:** 2026-03-23
**Audited version:** `1570bfc` (current deployed, post-action-item fixes)
**Auditor:** Claude Code (Opus 4.6, 1M context)
**Scope:** All 20 TypeScript files in `builds/auto-turn-off/src/` (full end-to-end trace)
**Predecessor:** `2026-03-23-audit-findings.md` (v1 audit at `18aaf70`)

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| HIGH | 3 | Concurrency data corruption, rescan re-enable audit always written, snapshot counters race |
| MEDIUM | 7 | Stale campaign detail in batch kill, double-counting blocked variants, isDryRun shadowing, dashboard resolution key mismatch, leads contacted formula, rescan KV list pagination, OFF regex false negatives |
| LOW | 9 | Various cleanup, dead code paths, type safety, timing edge cases |

The v1 audit found the right structural issues. This audit goes deeper into data-flow correctness, concurrency edge cases in the shared mutable state, and subtle logic bugs that affect audit trail accuracy.

---

## V1 Audit Status (What Was Fixed)

| V1 Finding | Status |
|------------|--------|
| HIGH-2: MAX_PERSISTENCE_CHECKS=20 | FIXED: Now 100, moved to config.ts |
| MEDIUM-2: No env var validation | FIXED: Validation block at top of executeScheduledRun() |
| MEDIUM-3: No API retry for 429 | FIXED: Single retry with 2s backoff in instantly-direct.ts:51-57 |
| MEDIUM-6: JSON parse crash | FIXED: try/catch in InstantlyDirectApi constructor |
| LOW-3: parser.ts unused | FIXED: Deleted |
| LOW-4: mergeNotification dead code | FIXED: Deleted |
| LOW-12: Dead send*Notification functions | FIXED: Deleted |
| LOW-5 (partial): MAX_PERSISTENCE_CHECKS moved to config | FIXED |
| MEDIUM-4: Revert uses broken MCP | NOT FIXED: revert.ts:142 still instantiates McpClient |
| HIGH-1: Kill cap race condition | NOT FIXED: killBudgetRemaining still shared mutable |

---

## New Findings

### HIGH-1: Snapshot accumulator data corruption under concurrency

**File:** index.ts:625-688 (inside `processWithConcurrency` callback)
**What:** The `snapshotAcc` object is a shared mutable accumulator modified by multiple concurrent workers inside `processWithConcurrency()`. Multiple workers read-modify-write fields like `snapshotAcc.totalCampaigns++`, `snapshotAcc.totalVariants += campTotal`, and mutate nested objects (`snapshotAcc.byWorkspace[workspace.id].totalVariants += campTotal`) concurrently. JavaScript's `+=` is not atomic across `await` boundaries -- between reading and writing, another worker can execute.

Similarly, `snapshotAcc.campaignHealth.push(...)` from multiple workers can interleave, and the `if (!snapshotAcc.byWorkspace[workspace.id])` initialization check has a TOCTOU race: two campaigns from the same workspace could both see the key as missing and both initialize it, with the second overwriting the first's accumulated data.

**Impact:** Daily snapshot data (written to KV and Supabase) can have incorrect variant counts, campaign counts, and per-workspace/per-CM breakdowns. The snapshot is used for the CM supervision dashboard and morning digest. Magnitude: within a single workspace's campaigns processed concurrently (up to concurrencyCap=10-15 workers), counts can be off by the amount of interleaving. Cross-workspace is safe because workspaces are processed sequentially.

**Fix:** Either:
- (Simple) Move snapshot counting outside the concurrent callback -- collect campaign results, then tally sequentially after `processWithConcurrency` completes
- (Better) Use a per-campaign return value pattern: the callback returns `{ campTotal, campActive, campDisabled, campAbove, healthEntry }`, and the caller accumulates sequentially

---

### HIGH-2: Rescan RE_ENABLED audit entry written even when enableVariant fails

**File:** index.ts:1471-1502
**What:** After the rescan re-enable logic, the `RE_ENABLED` audit entry is written unconditionally at line 1471 -- it's outside both the `if (isDryRun)` and `else` blocks. It executes after the `if (decision.action === 'KEEP')` block regardless of whether `enableVariant()` succeeded or failed.

Trace the control flow:
1. Line 1364: `if (decision.action === 'KEEP')` -- enters the re-enable path
2. Line 1422-1469: `if (isDryRun)` branch increments counter and deletes KV; `else` branch calls `enableVariant()` and only increments/notifies on success
3. Line 1471-1502: The `RE_ENABLED` audit entry -- this code runs after BOTH branches, including when `enableVariant()` returned false at line 1464

When `enableVariant()` fails (returns false), the variant is NOT re-enabled, but a `RE_ENABLED` audit entry is still written to both KV and Supabase. This creates a false audit trail.

**Impact:** Supabase `audit_logs` can contain `RE_ENABLED` entries for variants that are still disabled. Anyone querying the audit trail (dashboard, digest, manual review) would believe the variant was re-enabled when it wasn't.

**Fix:** Move the RE_ENABLED audit write inside the `if (success)` block at line 1443, or gate it with a boolean flag set only on success.

---

### HIGH-3: Run summary counters corrupted by concurrent campaign processing

**File:** index.ts:464-472, 593, 827-895, 931, 1022
**What:** All run summary counters (`totalCampaignsEvaluated`, `totalVariantsKilled`, `totalVariantsBlocked`, `totalVariantsWarned`, `totalVariantsDeferred`, `totalErrors`, `killBudgetRemaining`) are shared mutable numbers incremented from inside the `processWithConcurrency` callback. Same class of bug as HIGH-1 but for the run summary.

The `++` and `--` operators on these variables are non-atomic across await points. Between the read and write of `totalVariantsKilled++` at line 1143, another concurrent worker can also increment it, and one increment is lost.

The `killBudgetRemaining--` at line 895 is the same v1 HIGH-1 race condition. The `killBudgetRemaining += pendingKills.length` at line 1203 (batch kill failure refund) is also racy.

**Impact:** Run summary data in KV and Supabase may undercount kills, blocks, warnings, and errors. The kill budget can be under/overshot. With concurrencyCap=10 and many active campaigns, the error magnitude scales with concurrency.

**Fix:** Same pattern as HIGH-1 fix -- collect results from each campaign, tally sequentially after concurrency completes.

---

### MEDIUM-1: Stale campaignDetail used for initial evaluation, fresh detail fetched for kill

**File:** index.ts:596-599 (initial fetch) vs 1112-1113 (fresh fetch for batch kill)
**What:** Phase 1 fetches `campaignDetail` at line 596, then uses it for threshold resolution, snapshot counting, and `evaluateStep()`. The batch kill execution at line 1112 correctly fetches a FRESH detail for the actual disable. However, between the initial fetch and the kill execution, another concurrent worker processing a different campaign in the same workspace could have already disabled variants in a shared step via a different campaign's kill.

More importantly: the `evaluateStep()` call at line 752 uses the initial `campaignDetail.sequences[0].steps[stepIndex]` to determine which variants are already disabled. If a variant was disabled by a previous campaign's batch kill (same workspace, same step -- possible with shared workspaces), the safety check would count it as active and potentially allow killing the actual last variant.

**Impact:** In shared workspaces where multiple campaigns share steps (unlikely but architecturally possible), the safety check could see stale state. In practice, Instantly campaigns have independent step structures, so this is theoretical. But the code architecture doesn't enforce this assumption.

**Fix:** The fresh fetch at line 1112 mitigates this for the actual kill write. Add a post-fetch safety re-check: after fetching fresh details but before applying disables, re-run safetyCheck against the fresh step data.

---

### MEDIUM-2: Double-counting of blocked variants when KILLS_ENABLED=false

**File:** index.ts:1087-1109
**What:** When `KILLS_ENABLED=false`, pending kills are written as `BLOCKED` audit entries and `dashboardBlocked.push(pausedAudit)` is called. But at line 1105, `totalVariantsBlocked++` is incremented for each pending kill. These are in addition to any variants blocked by `evaluateStep()` returning a `blocked` value (line 931). If a step has 3 kill candidates and 1 blocked candidate, the blocked count would be 4 (3 kills-turned-blocked + 1 actual-blocked).

The `totalVariantsBlocked` counter conflates two different things: variants that couldn't be killed because they're the last active, and variants that would have been killed but KILLS_ENABLED=false.

**Impact:** Run summary `variantsBlocked` count is inflated, making it look like more steps have the last-variant problem than actually do. This misleads monitoring and digest data.

**Fix:** Add a separate counter (`totalVariantsKillsPaused`) for the KILLS_ENABLED=false case, or don't count these as "blocked" in the run summary.

---

### MEDIUM-3: isDryRun variable shadowed inside concurrent callback

**File:** index.ts:513 (outer) vs 590 (inner)
**What:** Line 513 declares `const isDryRun = env.DRY_RUN === 'true';` in the outer scope. Line 590, inside the `processWithConcurrency` callback, declares `const isDryRun = env.DRY_RUN === 'true' || DRY_RUN_CMS.has(cmName ?? '');`. The inner `isDryRun` shadows the outer one.

This means the rescan entry written at line 864-882 inside the dry-run path uses the correct (inner) isDryRun. But the `isDryRun` used in the blocked notification check at line 972 also correctly uses the inner scope. However, the notification flush at line 2038 uses the OUTER isDryRun (line 513), meaning it doesn't account for per-CM dry run status.

The notification flush calls `collector.flush(env.SLACK_BOT_TOKEN, isDryRun, /* skipSlack */ true)`. Since `skipSlack` is always true (digest-only mode), this is currently harmless. But if skipSlack is ever changed to false, the flush would use the global dry-run flag, not the per-CM one. Notifications from per-CM dry-run CMs would be sent to Slack as if they were live.

**Impact:** Currently none (skipSlack=true). Latent bug that will surface when Slack notifications are re-enabled.

**Fix:** When re-enabling Slack notifications, the flush needs to be per-CM or the collector needs to track dry-run status per notification.

---

### MEDIUM-4: Dashboard resolution key does not include variant, but upsert key does

**File:** supabase.ts:186-198 (upsert key), supabase.ts:252 (resolution key), dashboard-state.ts:48-49 (activeKeys key)
**What:** The upsert in `upsertDashboardItem` uses `(cm, campaign_id, item_type, step)` as the unique key (line 186-198). The `activeKeys` set in `buildDashboardState` uses `${campaign_id}:${item_type}:${step ?? 'null'}` (line 49). The `resolveStaleItems` function compares against this same key format (line 252).

But BLOCKED items have a specific variant (step + variant), and a single step can have multiple blocked variants across runs (if the step structure changes). The upsert key doesn't include variant, so if Step 1 Variant A is blocked in one run and Step 1 Variant B is blocked in the next, the second upsert will update the first row (same cm, campaign, type, step), changing the variant context silently.

Similarly, if a step has variant A blocked and variant B killed (recorded as DISABLED dashboard item), both share the same key pattern. The DISABLED item for variant A and BLOCKED item for variant B can't coexist for the same step because the upsert key deduplicates on `(cm, campaign_id, item_type, step)` -- but they have different item_types, so this is actually fine.

The real issue: the dashboard shows at most ONE blocked variant per step. If a step has 2 blocked variants (e.g., 3 variants, 2 above threshold, can only kill 1, block 2 others), only the last one upserted is visible.

**Impact:** Dashboard may show the wrong blocked variant for a step, or only show one of multiple blocked variants. The step-level granularity is coarser than the actual situation.

**Fix:** Include variant in the upsert unique key. Requires a migration of the `dashboard_items` unique index to include variant.

---

### MEDIUM-5: Leads "contacted" formula in direct API mode double-counts bounced/unsubscribed

**File:** index.ts:1584
**What:** Line 1584 sets `contacted = completed + bounced + unsubscribed`. But `active` at line 1583 is calculated as `Math.max(0, totalLeads - completed - bounced - unsubscribed)`. So `contacted + active = totalLeads` (clamped), meaning `uncontacted = active` is correct.

However, the `contacted` value written to the leads audit log at line 1624 (`active_in_sequence: uncontacted`) is semantically wrong. In this context, `contacted` means "leads that are done" (completed + bounced + unsub), not "leads that have been emailed at least once". A lead that's been emailed once but is still in the active sequence counts as `active`, not `contacted`. The v1 audit noted this as M5 but the fix was never applied.

Additionally, the `skipped` count is hardcoded to 0 in direct API mode (line 1582) but is included in the MCP mode's `contacted` formula (line 1599: `contacted = completed + bounced + skipped + unsubscribed`). This means the two modes produce different `contacted` values for the same campaign data, making audit log comparisons unreliable if the mode ever switches.

**Impact:** Audit trail inconsistency between modes. The evaluation logic itself is correct (uses `uncontacted` = `active` for both), so no functional impact on alerts.

**Fix:** Align the `contacted` formula between modes. In direct mode, set `contacted = totalLeads - active` to be consistent. Add a `source: 'batch'` field to the audit entry.

---

### MEDIUM-6: Rescan phase only reads first page of KV list (max 1000 keys)

**File:** index.ts:1244
**What:** The rescan phase calls `env.KV.list({ prefix: 'rescan:' })` without pagination. Cloudflare KV `list()` returns at most 1000 keys per call. If there are more than 1000 rescan entries (e.g., after a large purge or during heavy kill activity), only the first 1000 are processed. The remaining entries sit in KV until they expire (48h TTL) without being checked.

With current scale (18 workspaces, ~140 campaigns, 10 kills/run, 3 runs/day = 30 entries/day), this won't be hit. But at full fleet with 240+ campaigns, a single bad day could create 100+ rescan entries, and over the 48h TTL window, entries accumulate.

**Impact:** At scale, some killed variants in the redemption window may never be rescanned and will silently expire without checking for late-arriving opportunities. The variant stays disabled when it could have been redeemed.

**Fix:** Add pagination: check `rescanKeys.list_complete` and continue listing with `cursor` until all keys are processed. Same pattern as `clearV1Keys` at line 126-137.

---

### MEDIUM-7: isOffCampaign regex has false negatives for multi-line/Unicode campaign names

**File:** index.ts:114
**What:** The regex `/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF[\s\-]/iu` requires `OFF` to be followed by whitespace or hyphen. Campaign names like `"OFF(Carlos)"` (no space after OFF) or `"OFF:"` would not match. The regex also requires `OFF` to appear at the start (after optional emoji/whitespace), so `"Campaign OFF - Carlos"` would not match.

More subtly, the `i` and `u` flags are both set. The `u` flag enables Unicode mode, which is correct for `\p{}` property escapes. But the `\uFE0F` (variation selector) is inside the character class along with `\p{Emoji_Presentation}` and `\p{Extended_Pictographic}` -- this works but is redundant since variation selectors are already covered by Extended_Pictographic in Unicode mode.

**Impact:** Campaigns with non-standard OFF naming conventions (no space/dash after OFF) would be treated as regular campaigns and evaluated with the base threshold instead of the 20% buffered threshold. This means they'd be killed sooner than intended.

**Fix:** Broaden the regex: `/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF[\s\-\(]/iu` or simply `/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF\b/iu` (word boundary).

---

### LOW-1: MCP client always instantiated even in direct API mode

**File:** index.ts:452-453
**What:** Lines 452-453 always create `const mcp = new McpClient()` and `const mcpApi = new InstantlyApi(mcp)`, even when `useDirectApi=true` and MCP is never used. The MCP client is not connected (line 517-519 gates the `mcp.connect()` call), so it's inert. But the close at line 2142 (`mcp.close()`) runs on every run, calling abort on a null controller.

**Impact:** Negligible overhead. Creates unnecessary objects. The `mcp.close()` in the finally block is a no-op but adds noise to error handling.

**Fix:** Guard instantiation: `const mcp = useDirectApi ? null : new McpClient()`.

---

### LOW-2: Persistence monitor can't find workspace for kills made before rescan entry expired

**File:** index.ts:1928-1949
**What:** Phase 4 (persistence monitor) resolves workspace info by looking up the rescan entry for the first kill in each campaign group. But rescan entries have a 48h TTL (RESCAN_TTL_SECONDS=172800). Kill dedup keys have a 7-day TTL. So for kills older than 48h, the rescan entry is gone, and the persistence check skips the entire campaign with "no workspace found" at line 1948.

This means ghost re-enables are only detectable during the first 48h after a kill, not the full 7-day kill dedup window.

**Impact:** Ghost re-enables that happen 2-7 days after a kill go undetected. The persistence monitor is only effective during the rescan window.

**Fix:** Store workspace metadata in the kill dedup KV value (currently stores `{campaignId, stepIndex, variantIndex, killedAt}`). Add `workspaceId, workspaceName, cmName, campaignName, product` to the kill dedup entry.

---

### LOW-3: Dashboard HTML renders `e.step + 1` but audit entries already store 1-indexed step

**File:** dashboard.ts:161
**What:** The dashboard HTML renders `<td>${e.step + 1}</td>` at line 161. But audit entries are written with `step: stepIndex + 1` (e.g., index.ts:816, 949). So the dashboard displays step numbers as 2-indexed (step 1 shows as "2").

**Impact:** Incorrect step numbers in the KV dashboard view (`/__dashboard`). The Supabase-backed CM dashboard is unaffected (separate rendering).

**Fix:** Change line 161 to `<td>${e.step}</td>`.

---

### LOW-4: Warning dedup key not written in dry-run mode

**File:** index.ts:1059-1078
**What:** When `isDryRun=true`, the warning is logged and audit entries are written, but the dedup key `env.KV.put(dedupKey, '1', ...)` at line 1077 is inside the `else` (non-dry-run) branch. This means every dry-run evaluation will re-trigger warnings for the same variants, flooding the audit logs with duplicate WARNING entries.

In dry-run mode, this creates noisy audit data. Each of the 3 daily runs would re-log warnings for the same variants (9 warning entries per day per variant instead of 1).

**Impact:** Audit log pollution in dry-run mode. Run summary `variantsWarned` counts are inflated (reporting 3x the actual unique warnings).

**Fix:** Write the dedup key in dry-run mode too, or explicitly document this as intended behavior for dry-run testing.

---

### LOW-5: Blocked dedup key uses hardcoded TTL instead of config constant

**File:** index.ts:1001
**What:** The blocked dedup key TTL is hardcoded as `expirationTtl: 604800` (7 days) at line 1001. The kill dedup uses the config constant `KILL_DEDUP_TTL_SECONDS` which is also 604800. But if someone changes the config constant, the blocked dedup TTL won't change.

**Impact:** Maintenance inconsistency. If kill TTL is changed in config.ts, blocked TTL stays at 7 days.

**Fix:** Use `KILL_DEDUP_TTL_SECONDS` for the blocked dedup key too, or add a separate `BLOCKED_DEDUP_TTL_SECONDS` constant.

---

### LOW-6: Batch kill failure refund restores budget but doesn't un-decrement per-kill

**File:** index.ts:895 (decrement per kill), 1203 (refund on batch failure)
**What:** During kill evaluation, `killBudgetRemaining--` is called for each pending kill that passes dedup (line 895). If the batch kill execution fails (catch block at line 1199), `killBudgetRemaining += pendingKills.length` refunds the entire batch.

But between the individual decrements (during evaluation) and the refund (during execution), other concurrent workers may have been deferred because the budget appeared exhausted. Those deferred variants won't be un-deferred retroactively.

Example: Campaign A has 8 kill candidates, budget is 10. Budget goes to 2 after evaluation. Campaign B (concurrent) has 5 candidates, defers 3 of them. Campaign A's batch kill then fails, budget goes back to 10. But Campaign B's 3 deferred variants are already written as DEFERRED and won't be retried until the next run.

**Impact:** Over-deferral in failure scenarios. Self-healing (deferred variants are retried next run), but unnecessarily delays kills by one run cycle (4-6 hours).

**Fix:** Move kill evaluation and budget management out of the concurrent loop (same fix as v1 HIGH-1).

---

### LOW-7: No CORS headers on HTTP endpoints

**File:** index.ts:346-381
**What:** The fetch handler serves the dashboard, baseline, backfill, revert, and clear-v1-keys endpoints without any CORS headers. If the CM supervision dashboard (hosted on Vercel) tries to fetch data from these endpoints directly, browser CORS policy will block the request.

**Impact:** Currently no cross-origin access needed (the dashboard reads from Supabase, not the worker endpoints). But if any frontend ever needs to call these endpoints directly, it will fail.

**Fix:** Add CORS headers to the dashboard and API endpoints if cross-origin access is needed.

---

### LOW-8: Supabase writes use fire-and-forget pattern with only console.error on failure

**File:** supabase.ts (all write functions), index.ts (all `if (sb) await write*` calls)
**What:** Every Supabase write is individually awaited but failures only produce `console.error`. There's no retry, no fallback, and no aggregated error tracking. If Supabase is down for a full run, every single write fails silently, and the run completes "successfully" with zero Supabase data.

The run summary would still be written to KV, but with no indication that Supabase writes failed. The `totalErrors` counter only tracks API/kill errors, not Supabase write errors.

**Impact:** Silent data loss in Supabase during outages. KV remains the source of truth, but the backfill endpoint (`/__backfill`) would need to be run manually to recover.

**Fix:** Add a Supabase error counter to the run summary. If errors exceed a threshold (e.g., 5), log a structured warning that can be monitored.

---

### LOW-9: `contacted` value from `getCampaignAnalytics` returns 0 on unexpected response shape

**File:** instantly-direct.ts:174-185
**What:** `getCampaignAnalytics()` falls back to `{ contacted: 0, sent: 0 }` if the response shape is unexpected. This value feeds the sanity check at index.ts:715: `if (contactedCount > 0 && step1TotalSent > contactedCount * 1.1)`.

If the API returns an unexpected shape, `contactedCount=0`, and the sanity check's `contactedCount > 0` guard prevents the skip. So the campaign is evaluated normally. This is the safe direction -- it doesn't skip campaigns that should be evaluated.

But: if the API response shape changes to return `contacted` under a different key name, this would silently return 0 for all campaigns, disabling the sanity check entirely. The sanity check is a safety net; its silent disablement wouldn't be noticed.

**Impact:** Low -- the sanity check is defensive and its absence doesn't cause false kills. But loss of the safety net should be detectable.

**Fix:** Log a warning when `getCampaignAnalytics` returns the default fallback.

---

## Corrections to V1 Findings

### V1 MEDIUM-5 (uncontacted field name) -- Still Unfixed
The v1 audit noted that `uncontacted` is set to `active` in direct API mode, which represents "leads still in sequence" not "never contacted." The action items document listed this but it was never implemented. The field name `active_in_sequence` already exists in the LeadsAuditEntry type (types.ts:58) and is used in the audit entry, so the TYPE is correct but the VALUE assigned is confusing because it's derived differently in each mode.

### V1 MEDIUM-4 (Revert MCP path) -- Still Unfixed
revert.ts:141-143 still creates `McpClient` and `InstantlyApi(mcp)` for the non-direct path. The `INSTANTLY_MODE` check at line 141 correctly gates it, but the MCP fallback path is broken.

### V1 LOW-5 (hardcoded values) -- Partially Fixed
`MAX_PERSISTENCE_CHECKS` was moved to config.ts. Other hardcoded values remain (lock TTL at 30min, stale trigger at 5min, audit KV TTL at 90 days, Slack rate-limit sleeps).

---

## Cross-Cutting Concerns

### 1. Concurrency is the #1 systemic risk
Three separate HIGH/MEDIUM findings (HIGH-1, HIGH-3, MEDIUM-1) stem from the same root cause: shared mutable state inside `processWithConcurrency`. This is the single most important architectural fix needed. The solution is the same for all three: change the concurrent callback to return results, then process them sequentially.

### 2. Audit trail accuracy gaps
Between HIGH-2 (false RE_ENABLED entries), LOW-3 (step off-by-one in dashboard), LOW-4 (warning dedup not written in dry-run), and MEDIUM-2 (blocked double-counting), the audit trail has multiple accuracy issues. None cause incorrect kills, but they degrade trust in the monitoring data.

### 3. KV pagination assumption
Both the rescan phase (MEDIUM-6) and Phase 4 persistence monitor rely on single-page KV list calls. At current scale this works. At full fleet, both will silently truncate.

### 4. Dead code remaining
- `mcp-durable-object.ts`, `mcp-do-client.ts`, `mcp-test.ts`, `api-field-test.ts` -- 4 files that appear to be test/experimental code not used in production
- `McpClient` and `InstantlyApi` classes are still imported and instantiated on every run even in direct API mode
- `serveDashboard()` in `dashboard.ts` is an internal debugging tool, not the production CM dashboard

### 5. No input sanitization on HTTP endpoints
The fetch handler accepts arbitrary URL params (`date`, `prefix`, `cursor`, `note`, etc.) without validation. While these are internal endpoints (no public exposure), a malformed `date` param could cause `new Date(date + 'T00:00:00Z')` to return NaN, propagating through the dashboard rendering.

### 6. Version tracking is solid
Every Supabase write includes `worker_version: WORKER_VERSION` (from version.ts, auto-generated by deploy.sh). The deploy protocol is well-documented. This is good practice.

---

## Architecture Recommendations (Not in V1)

### 1. Extract concurrent processing to return-value pattern
Replace the shared-mutable-state concurrent pattern with:
```typescript
interface CampaignResult {
  kills: KillAction[];
  blocked: AuditEntry[];
  warnings: AuditEntry[];
  snapshot: CampaignSnapshot;
  leadsCandidate: LeadsCheckCandidate | null;
  errors: number;
}

const results: CampaignResult[] = [];
await processWithConcurrency(activeCampaigns, concurrencyCap, async (campaign) => {
  const result = await evaluateCampaign(campaign, ...);
  results.push(result); // Array.push is safe in single-threaded JS
});
// Sequential processing of results
for (const result of results) { ... }
```
This eliminates HIGH-1, HIGH-3, MEDIUM-1, and LOW-6 in one refactor.

### 2. Add a "run health" indicator
Track Supabase write failures, API errors, and data anomalies as a single health score in the run summary. Alert (via Slack or dashboard) when health degrades. Currently errors are counted but there's no threshold-based alerting on run health.

### 3. Separate "evaluation" from "execution"
The 1700-line `executeScheduledRun` function mixes evaluation logic (read-only, safe to retry) with execution logic (API mutations, notifications). Separating these into `evaluate()` -> `execute(plan)` would make the code more testable and the concurrency issue trivial to fix (evaluation is concurrent, execution is sequential).
