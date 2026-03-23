# Campaign Control - Full Technical Audit Spec

**Date:** 2026-03-23
**Owner:** Sam (delegated to secondary Claude Code chat)
**Current version:** `18aaf70` (latest deployed)
**Codebase:** `builds/auto-turn-off/src/` (4,525 lines, 13 TypeScript files)

---

## Objective

Comprehensive codebase audit of the Campaign Control auto turn-off worker. Goal: find bugs, missed edge cases, optimization opportunities, and things we didn't know were broken. This is NOT targeted at a single issue - it's a full sweep.

## Codebase Map

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 2,166 | Main worker: 5-phase cron (workspace fetch, variant eval, leads check, dashboard state, digest), HTTP routes, KV lock, audit logging |
| `slack.ts` | 461 | Notification formatting, grouped messages, morning digest, `NotificationCollector` |
| `types.ts` | 360 | All interfaces and type definitions |
| `supabase.ts` | 339 | Writes to 5 tables: `audit_logs`, `run_summaries`, `daily_snapshots`, `notifications`, `dashboard_items` + `resolution_log` |
| `instantly-direct.ts` | 272 | Direct Instantly API client (replaces MCP). Step analytics, campaign details, batch analytics |
| `revert.ts` | 266 | Manual revert endpoint (re-enable disabled variant via HTTP) |
| `evaluator.ts` | 156 | Core kill logic: `evaluateVariant()`, `evaluateStep()`, `safetyCheck()`, `checkVariantWarnings()` |
| `dashboard-state.ts` | 144 | CM supervision console: upserts BLOCKED/LEADS items, auto-resolves, resolution log |
| `config.ts` | 124 | Workspace configs (18 workspaces), thresholds, pilot CMs, dedup TTLs, constants |
| `thresholds.ts` | 95 | `resolveThreshold()`: product -> provider -> OFF buffer -> graduated threshold |
| `router.ts` | 69 | CM name resolution from campaign names, pilot filtering, Slack channel routing |
| `leads-monitor.ts` | 27 | `evaluateLeadDepletion()`: active lead count -> HEALTHY/WARNING/EXHAUSTED |
| `parser.ts` | 46 | Campaign name parsing (CM extraction) |

## Architecture Context

- **Platform:** Cloudflare Workers (cron triggers at 6am/12pm/6pm ET = 10/16/22 UTC, plus 12:00 UTC digest-only)
- **State:** Cloudflare KV (dedup keys, lock, rescan queue) + Supabase (audit logs, dashboards)
- **External APIs:** Instantly (direct REST, base64-encoded API keys per workspace), Slack (Bot token)
- **Mode:** `INSTANTLY_MODE=direct` (MCP fallback exists but broken - Railway SSE connectivity issues)
- **Kill safety:** `KILLS_ENABLED=true`, `MAX_KILLS_PER_RUN=10`, `DRY_RUN=false`

## Audit Areas (7 domains)

### 1. Core Evaluation Logic
**Files:** `evaluator.ts`, `thresholds.ts`, `config.ts`

Verify:
- `evaluateVariant()` - threshold as both min-sends gate AND ratio ceiling. Is this correct behavior? Edge case: variant with exactly `threshold` sends and 1 opp.
- `OPP_RUNWAY_MULTIPLIER` (1.1x) stacking with `OFF_CAMPAIGN_BUFFER` (1.2x). Is the multiplication order correct? Does `effective_threshold` in audit logs reflect the fully stacked value?
- `safetyCheck()` - does it correctly count remaining active variants? What if `v_disabled` is undefined vs false vs missing?
- `evaluateStep()` - analytics rows referencing non-existent variant indices (the console.warn path). Can this cause silent data loss?
- `checkVariantWarnings()` at 80% threshold - does this overlap with the kill path when sent is exactly at threshold?
- `resolveThreshold()` - trace through the full chain: product threshold -> provider override -> OFF buffer. Any gaps for unknown provider codes?

### 2. API Integration & Data Accuracy
**Files:** `instantly-direct.ts`, `index.ts` (Phase 1-2)

Verify:
- `getStepAnalytics()` - no date filter (removed in `ff07af8`). Confirm no other call sites accidentally re-introduce it.
- `getCampaignAnalytics()` - URL pattern uses query param (`?campaign_id=`). Verify against Instantly API docs. Any other endpoints with similar ambiguity?
- `getBatchCampaignAnalytics()` - used in Phase 3 for leads. Returns lifetime accumulators. Verify the `active = leads_count - completed - bounced - unsubscribed` formula. Can any of these go negative? Is `clamped to >=0` actually implemented?
- API key decoding: base64-encoded keys from `INSTANTLY_API_KEYS` env var. Any error handling for malformed keys?
- Rate limiting: how many API calls per cron run? Any backoff/retry logic? What happens if Instantly rate-limits mid-run?
- Error handling: if one workspace fails, does the whole run abort? Partial failure modes?

### 3. State Management & Concurrency
**Files:** `index.ts` (KV operations), `supabase.ts`

Verify:
- **KV lock:** `acquireLock()` uses timestamp comparison with 30-min TTL. Race condition: two workers read "no lock" simultaneously, both write. Is this possible on Cloudflare Workers?
- **Dedup keys:** `WARNING_DEDUP_TTL_SECONDS` (24h), `KILL_DEDUP_TTL_SECONDS` (7d), leads dedup (48h). Are all dedup checks correct? Any path that skips dedup?
- **Kill cap:** `MAX_KILLS_PER_RUN=10` with DEFERRED logging. Does the counter reset correctly per run? Any race between kill execution and counter increment?
- **Supabase writes:** Are they all awaited? Any fire-and-forget that could silently fail? What happens if Supabase is down during a run?
- **KV vs Supabase consistency:** If KV write succeeds but Supabase fails, do we get ghost state?

### 4. Notification System
**Files:** `slack.ts`, `router.ts`, `config.ts`

Verify:
- **`NotificationCollector`** - grouped notifications. Does flushing with `skipSlack=true` actually suppress ALL Slack calls? Any code path that bypasses the collector?
- **Morning digest** (`sendMorningDigest`) - reads `dashboard_items` from Supabase. What if the table is empty? What if items were just resolved?
- **CM routing:** `resolveCmName()` parses campaign names. What's the fallback when parsing fails? Does it always fall back to workspace `defaultCm`? What about shared workspaces (null defaultCm)?
- **Channel mapping:** `CM_MONITOR_CHANNELS` only has 4 pilot CMs. What happens when a non-pilot CM's campaign triggers an action? Silent drop or error?
- **Thread management:** Notifications have `thread_ts: null`. When Slack is re-enabled, will threading work correctly?

### 5. Dashboard State
**Files:** `dashboard-state.ts`, `supabase.ts`

Verify:
- `buildDashboardState()` - upserts to `dashboard_items`. What's the upsert key? Can duplicate items accumulate?
- Auto-resolution: when a BLOCKED variant is no longer blocked, does it get resolved? What about LEADS items that recover?
- `dismissed_at` reset on re-detection (`0def5ae`). Does this create notification fatigue for CMs?
- `resolution_log` entries with `resolution_method: 'auto'`. Is there a path for manual resolution?
- Dashboard URL generation: `DASHBOARD_BASE_URL` pointing to Vercel. Any query params for filtering?

### 6. Leads Monitoring (Phase 3)
**Files:** `leads-monitor.ts`, `index.ts` (Phase 3), `instantly-direct.ts`

Verify:
- `evaluateLeadDepletion()` - only 27 lines. Trace the full logic. Threshold for WARNING vs EXHAUSTED.
- **Batch analytics approximation:** `active = leads_count - completed - bounced - unsubscribed`. Known issue: lifetime accumulators for campaigns with lead cycling. How bad is this in practice? Any campaigns where this gives wildly wrong results?
- MCP fallback code: still present but broken. Is dead code causing confusion? Should it be removed or clearly gated?
- Leads dedup: campaigns can flip between WARNING <-> EXHAUSTED <-> HEALTHY. Does dedup handle all transitions correctly?

### 7. Redemption Window (Rescan)
**Files:** `index.ts` (rescan phase)

Verify:
- Rescan queue: disabled variants get a `RESCAN_DELAY_HOURS=4` delay, then rechecked within `RESCAN_MAX_WINDOW_HOURS=48`.
- What if the variant gained an opp during the window? Does re-enable work correctly via the Instantly API?
- `GHOST_REENABLE` detection: what is this? When does it fire? Is it working?
- Expired entries: what happens after 48h with no redemption? Just logged as EXPIRED?
- KV TTL of rescan entries (172800s = 48h) matches `RESCAN_MAX_WINDOW_HOURS`. But what if the entry expires from KV before the expiration check runs?

## Cross-Cutting Concerns

Check across ALL files:
- **Error boundaries:** Does any unhandled exception crash the entire cron? Is there a top-level try/catch?
- **Logging:** Console.log/warn/error patterns. Are errors distinguishable from info?
- **TypeScript strictness:** Any `as any` casts, non-null assertions (`!`), or type mismatches?
- **Dead code:** MCP-related code paths, unused imports, commented-out blocks
- **Hardcoded values:** Magic numbers not in config.ts, hardcoded workspace IDs, etc.
- **Version tag:** Is `src/version.ts` correctly embedded in all Supabase writes?
- **Env var validation:** What happens if a required env var is missing?

## Known Issues to Validate (not investigate from scratch)

These are documented but may have drifted:
1. Leads monitoring uses batch analytics approximation (known inaccurate for lead cycling campaigns)
2. Slack notifications are fully suppressed (only digest). Confirm no leaks.
3. `PILOT_CMS` filter limits evaluation scope. Confirm non-pilot campaigns are truly skipped, not just silently evaluated.

## Deliverables

1. **Findings document** (`specs/2026-03-23-audit-findings.md`) - every finding as:
   - Severity: CRITICAL / HIGH / MEDIUM / LOW
   - File + line number
   - What's wrong / what could go wrong
   - Recommended fix (brief)
2. **Quick wins list** - anything that can be fixed in <10 lines with zero risk
3. **Architecture observations** - anything structural (not bugs) worth noting for future work

## Execution Instructions

1. Read this spec + the full source files listed in the Codebase Map
2. Read `VERSION_REGISTRY.md` for version history context
3. Read `caveats-and-action-items.md` for known open items
4. Run `/technical` persona against each audit domain (can parallelize domains 1-7)
5. Run `/cc-review` against all findings before finalizing
6. Compile into the deliverables listed above
7. Do NOT deploy anything. This is read-only audit. No code changes.
8. Do NOT read files outside `builds/auto-turn-off/` - everything you need is in this directory
