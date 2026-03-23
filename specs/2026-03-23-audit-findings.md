# Campaign Control - Full Technical Audit Findings

**Date:** 2026-03-23
**Audited version:** `18aaf70`
**Auditor:** Claude Code (Opus 4.6)
**Scope:** All 13 source files in `builds/auto-turn-off/src/` (4,525 lines)
**CC Review:** APPROVED (all findings validated against source)

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 6 |
| LOW | 12 |

No critical bugs found. The system is fundamentally sound. Two HIGH findings relate to safety mechanisms that can be bypassed under specific conditions. The core evaluation, kill, and notification paths are correct.

---

## Findings

### HIGH-1: Kill cap race condition in concurrent processing

**File:** index.ts:451,867
**What:** `killBudgetRemaining` is a mutable number shared across concurrent campaign processing workers inside `processWithConcurrency()`. Multiple workers can read the budget, both see it as >0, and both decrement it. Between the check (line 803) and decrement (line 867), multiple `await` calls yield execution, allowing concurrent workers to both pass the budget check. The kill cap of 10 can be exceeded by up to `concurrencyCap - 1` (currently 9) in a single run.
**Impact:** Up to 19 kills instead of 10 in a worst-case concurrent run. Undermines the safety mechanism designed to prevent large initial purges.
**Fix:** Move kill cap enforcement out of the concurrent loop. Either:
- (Simple) Collect all kill candidates during evaluation, then process the top N sequentially after processWithConcurrency completes, or
- (Better) Use an atomic counter pattern with synchronous check-and-decrement before any async operation.

### HIGH-2: Ghost re-enable detection limited to 20 checks

**File:** index.ts:1857-1858
**What:** `MAX_PERSISTENCE_CHECKS = 20` hard limit means only 20 kill dedup keys are checked per run. With 10 kills/run, 3 runs/day, and 7-day dedup TTL, there could be 210+ active kill keys. Only ~10% are checked each run.
**Impact:** Ghost re-enables (CMs or external processes re-enabling killed variants) go undetected for the majority of variants. Phase 4 persistence monitoring is largely decorative at current scale.
**Fix:** Increase `MAX_PERSISTENCE_CHECKS` to 100-200. Or restructure: group by campaign (one getCampaignDetails call per campaign, check all variants in that campaign) to make more checks for fewer API calls.

---

### MEDIUM-1: KV lock TOCTOU race condition

**File:** index.ts:52-60
**What:** `acquireLock()` reads the lock, checks the timestamp, then writes. Two workers could both read "no lock" simultaneously, both write, and both proceed. KV doesn't support atomic compare-and-swap.
**Impact:** Two concurrent runs could execute simultaneously. Mitigated by: (1) CF cron is typically single-instance, (2) stale-trigger check rejects catch-up runs >5min late, (3) each kill has its own dedup check. Practical risk is low.
**Fix:** Accept the risk given mitigations, or add a random delay + re-read pattern after writing the lock.

### MEDIUM-2: No env var validation at startup

**File:** index.ts:412-493
**What:** No validation of required env vars (`INSTANTLY_API_KEYS`, `SLACK_BOT_TOKEN`, `KILLS_ENABLED`). Missing or malformed values are discovered at runtime mid-run, not at startup.
**Impact:** A misconfigured deploy could partially execute (some API calls succeed, some fail) before crashing. The stale-trigger guard won't help here.
**Fix:** Add a validation block at the top of `executeScheduledRun()` that checks all required env vars before acquiring the lock.

### MEDIUM-3: No API retry/backoff logic

**File:** instantly-direct.ts:34-50
**What:** All API calls throw on non-200 responses with no retry logic. If Instantly rate-limits mid-run, affected campaigns are skipped with an error.
**Impact:** Under load, partial runs with many errors. Campaigns are re-evaluated next run (self-healing), but the run's data is incomplete.
**Fix:** Add a simple retry with exponential backoff (1 retry, 2s delay) for 429 status codes. Low effort, high resilience gain.

### MEDIUM-4: Revert endpoint uses broken MCP path

**File:** revert.ts:140-142
**What:** `handleRevert()` instantiates `McpClient()` and `InstantlyApi(mcp)` for live revert operations. MCP SSE connectivity from CF edge to Railway is broken (documented). A live revert attempt will fail.
**Impact:** The `/__revert?dry_run=false` endpoint is non-functional. Dry-run mode works (reads Supabase only). If a bulk revert is needed, it can't be done through the worker.
**Fix:** Update revert.ts to use `InstantlyDirectApi` when `INSTANTLY_MODE=direct`. Mirror the pattern from index.ts.

### MEDIUM-5: `uncontacted` field name misleads in direct API mode

**File:** index.ts:1552-1554
**What:** In direct API mode, `uncontacted` is set to `active` (leads_count - completed - bounced - unsubscribed). This represents "leads still in sequence" (including those already emailed but not yet completed), NOT "leads that haven't been emailed yet". The audit log field `leads_uncontacted` stores this value.
**Impact:** Anyone reading leads audit data in Supabase would interpret `leads_uncontacted` as "never contacted", which is wrong. The evaluation logic itself is correct (checking whether active leads remain), but the label misleads.
**Fix:** Rename to `active_in_sequence` or add a `source` field to the audit entry clarifying the semantics in direct mode (already partially present in the type but not set).

### MEDIUM-6: INSTANTLY_API_KEYS parse failure crashes worker

**File:** instantly-direct.ts:14-16
**What:** `JSON.parse(keyMapJson)` in the constructor has no try/catch. If the env var contains malformed JSON, the entire worker crashes on initialization.
**Impact:** Complete worker failure if the env var is misconfigured. No graceful degradation.
**Fix:** Wrap in try/catch, log the error, throw a descriptive error.

---

### LOW-1: Infra threshold cached for 7 days

**File:** thresholds.ts:92
**What:** Provider-based thresholds are cached in KV for 7 days. If a campaign's email tags change providers (e.g., migrated from Google to Outlook), the threshold won't update for up to 7 days.
**Recommendation:** Acceptable. Provider changes are rare and the default threshold is safe.

### LOW-2: `as any` casts reduce type safety

**Files:** instantly-direct.ts:167, index.ts:667, index.ts:1951
**What:** 3 `as any` casts bypass TypeScript type checking. Most common for API response shapes that aren't fully typed.
**Recommendation:** Define proper types for Instantly API responses. Low priority.

### LOW-3: parser.ts is completely unused

**File:** parser.ts (46 lines)
**What:** Neither `parseCmName()` nor `parseCmChannel()` are imported by any other file. The equivalent `resolveCmName()` in router.ts is used instead. parser.ts duplicates router.ts logic with minor differences.
**Recommendation:** Delete parser.ts.

### LOW-4: `mergeNotification()` is dead code

**File:** evaluator.ts:99-103
**What:** `mergeNotification()` is defined but never called. It was likely used before the per-kill notification refactor.
**Recommendation:** Delete the function.

### LOW-5: Hardcoded values not in config.ts

**Files:** index.ts, thresholds.ts, slack.ts
**What:** Multiple hardcoded values scattered across files:
- `MAX_PERSISTENCE_CHECKS = 20` (index.ts:1857)
- `5 * 60 * 1000` stale trigger delay (index.ts:315)
- `30 * 60 * 1000` lock TTL (index.ts:56)
- `90 * 86400` audit log KV TTL (index.ts:72,77,82)
- `604800` infra threshold cache TTL (thresholds.ts:92)
- `1.1` sanity check ratio (index.ts:691)
- `300` and `200` ms Slack rate-limit sleeps (slack.ts:109,162)
**Recommendation:** Move to config.ts when touching these areas. Not urgent.

### LOW-6: Supabase client singleton persists across deploys

**File:** supabase.ts:5-12
**What:** Module-scoped `client` variable persists within a CF Worker isolate. If credentials change (env var update without isolate restart), the old client persists.
**Impact:** Negligible. CF Workers restart isolates on deploy.

### LOW-7: Shared workspace campaigns with no CM silently skipped

**File:** router.ts:44-69, index.ts:566
**What:** For shared workspaces (defaultCm=null) where campaign names don't contain a CM identifier (parenthesized name, "- CM" suffix), `resolveCmName()` returns null. `isPilotCampaign(null)` returns false. The campaign is silently skipped with no log output.
**Impact:** Campaigns in shared workspaces with non-standard naming are invisible to the system.
**Recommendation:** Add a `console.warn` for campaigns where CM resolution fails in shared workspaces.

### LOW-8: KV dedup prevents Supabase re-write on failed kill log

**File:** index.ts:858-873
**What:** If a kill's KV dedup key exists but the Supabase write failed on the original kill, the kill won't be re-attempted or re-written to Supabase. The KV dedup prevents re-notification AND re-logging.
**Impact:** Supabase audit_logs could be missing entries for kills that succeeded in Instantly but failed to write to Supabase. The kill itself was executed.

### LOW-9: Removed CM from pilot leaves orphaned dashboard items

**File:** dashboard-state.ts:137
**What:** `resolveStaleItems()` only runs for CMs in `PILOT_CMS`. If a CM is removed from the pilot, their active dashboard items are never resolved.
**Recommendation:** When modifying PILOT_CMS, manually resolve dashboard items for removed CMs via Supabase.

### LOW-10: `effective_threshold` missing from warning audit entries

**File:** index.ts:1008-1016
**What:** Warning audit entries don't include `effective_threshold` in the trigger field, unlike kill and blocked entries. The warning audit `trigger.threshold` is the base threshold, which may not reflect OFF buffer or OPP_RUNWAY_MULTIPLIER.
**Recommendation:** Add `effective_threshold` to warning audit entries for consistency.

### LOW-11: Backfill endpoint has no concurrency control

**File:** index.ts:2136-2159
**What:** `backfillKvToSupabase()` processes all KV entries via `Promise.all(list.keys.map(...))` with up to 500 concurrent Supabase inserts. No concurrency limiting.
**Impact:** Could overwhelm Supabase during a large backfill. Not a runtime concern (backfill is manual/one-time).
**Recommendation:** Add chunking (e.g., process 20 at a time).

### LOW-12: Dead exported functions in slack.ts

**File:** slack.ts:258-429
**What:** Six `send*Notification()` functions (`sendKillNotification`, `sendLastVariantNotification`, `sendWarningNotification`, `sendRescanNotification`, `sendLeadsWarningNotification`, `sendLeadsExhaustedNotification`) are exported but never called from any file. The main flow uses `collector.add()` + `format*Details()` instead. ~180 lines of dead code.
**Recommendation:** Delete these functions. Keep the `format*` functions which ARE used.

---

## Quick Wins (< 10 lines, zero risk)

| # | Fix | File | Lines |
|---|-----|------|-------|
| 1 | Delete `parser.ts` | parser.ts | 46 lines removed |
| 2 | Delete `mergeNotification()` | evaluator.ts:99-103 | 5 lines removed |
| 3 | Add `console.warn` for unresolved CM in shared workspaces | router.ts:68 | +1 line |
| 4 | Add `effective_threshold` to warning audit entry trigger | index.ts:1008 | +1 field |
| 5 | Increase `MAX_PERSISTENCE_CHECKS` from 20 to 100 | index.ts:1857 | 1 line change |
| 6 | Move `MAX_PERSISTENCE_CHECKS` to config.ts | config.ts + index.ts | 2 lines |

---

## Architecture Observations

### 1. Single-file monolith risk
`index.ts` is 2,166 lines containing the entire 5-phase cron flow, HTTP routing, lock management, snapshot building, leads processing, rescan, persistence monitoring, notifications, and backfill. The function `executeScheduledRun()` alone is ~1,700 lines. This makes targeted changes risky (high blast radius per edit) and code review difficult.

**Suggestion:** Extract phases into separate files: `phase-eval.ts`, `phase-rescan.ts`, `phase-leads.ts`, `phase-persistence.ts`, `phase-dashboard.ts`. Each phase would be a function that takes the shared state as a parameter.

### 2. Notification flow is well-separated
The `NotificationCollector` pattern cleanly decouples notification collection from delivery. The skipSlack flag works correctly. The morning digest flow is properly independent. This is good architecture.

### 3. Dual-write KV + Supabase adds complexity without transactionality
Every audit entry is written to both KV (primary, fast) and Supabase (durable, queryable). Neither write is dependent on the other. If one fails, the other succeeds. This is an eventually-consistent design that works well for the use case, but the lack of a reconciliation mechanism means discrepancies can accumulate silently. The backfill endpoint (`/__backfill`) partially addresses this but only for KV->Supabase, not the reverse.

### 4. MCP code paths should be removed or clearly gated
Three files still import MCP-related modules: `index.ts`, `revert.ts`, and the baseline flow. MCP SSE is broken from CF edge. The direct API is the production path. Having both creates confusion and maintenance burden. Consider:
- Remove MCP imports from index.ts (keep only the `if (!useDirectApi)` guard as a dead path marker)
- Fix revert.ts to use direct API
- Remove baseline flow's MCP path (or gate it)

### 5. The sanity check is a safety net, not a fix
The step 1 sent vs contacted sanity check (index.ts:684-696) catches inflated analytics but skips the entire campaign. This means campaigns with bad data are never evaluated. The right fix would be to investigate WHY analytics are inflated and fix the data source, using the sanity check as a monitoring signal rather than a kill gate.

### 6. Phase ordering is intentional and correct
The 5-phase ordering (eval -> rescan -> leads -> persistence -> dashboard) ensures:
- Kills happen before rescans (no interference)
- Leads checks happen after eval (uses the same campaign data)
- Persistence checks happen after kills (catches ghost re-enables from this run or previous)
- Dashboard state is built last (has complete picture of all phases)

This is well-designed.
