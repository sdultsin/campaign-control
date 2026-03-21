# Campaign Control: Cron Data Loss -- Investigation & Fix Brief

**Date:** 2026-03-19
**For:** Next Claude Code instance
**Status:** Investigation 80% complete. Fix drafted but needs validation. DO NOT DEPLOY.

---

## Your Mission

Campaign Control V2 cron runs are dying before completion. Mid-run Supabase writes (audit_logs, notifications) land fine, but end-of-run writes (run_summaries, daily_snapshots) never execute. KV is also empty. This is a data integrity issue -- the system appears to work (Slack messages go out) but the backend has massive gaps.

**Your task:**
1. Validate the hypotheses below by running a local invisible test
2. Confirm or refute each finding
3. Draft the minimal code fix (do NOT deploy)
4. Save the fix as a branch or clearly-marked files

---

## What We Already Know (Verified)

### The Data Gap

Supabase state for March 19, 2026:

| Run | Trigger | Audit Logs | Campaigns | run_summary? | daily_snapshot? |
|-----|---------|-----------|-----------|-------------|----------------|
| 6am ET (10:00 UTC) | CF cron | **1** | 1 | NO | NO |
| 9:33am (13:33 UTC) | wrangler dev | 266 | 36 | YES (65 camps, 901s) | YES |
| 9:54am (13:54 UTC) | wrangler dev | (same batch) | 32 | YES (7 errors, 66s) | NO |
| 11:04am (15:04 UTC) | wrangler dev | (same batch) | 36 | YES (65 camps, 902s) | YES |
| 12pm ET (16:00 UTC) | CF cron | **8** | 7 | NO | NO |

Local runs: 65 campaigns, 266 audit entries, ~15 minutes, all data written.
Cron runs: 1-8 audit entries, fraction of campaigns, no end-of-run data.

### KV is Empty

`wrangler kv:key list --namespace-id c054b62e43b54a22bcc1ffa24bb72272` returns only a `test-key`. No `run:`, `snapshot:`, `kill:`, `rescan:`, `blocked:`, `warning:`, or `threshold:` keys. This means:
- Kill/warning dedup is non-functional (no state to check)
- Rescan window is broken (no entries stored)
- KV audit trail doesn't exist
- Either writes are silently failing in prod, or `/__clear-v1-keys` was hit

### V1 vs V2 Performance

- V1 (pre-March 18): 170+ campaigns in 35-50s, direct Instantly API calls, hourly cron, reliably wrote summaries
- V2 (March 19+): 65 campaigns in 900s, ALL calls routed through MCP (Worker -> Railway SSE -> Instantly -> Railway -> Worker)
- **50x slowdown per campaign** due to MCP network hops

### Slack Notifications DO Work on Cron

The 12pm cron posted warnings to #cc-alex, #cc-carlos, #cc-ido. All `reply_success: true`. The worker IS executing -- it just dies before finishing.

### Previous Fix (Already Deployed)

The same session added `await` to `writeRunSummaryToSupabase()` and `writeDailySnapshotToSupabase()` at lines 1807-1809. This fixed fire-and-forget at end-of-run. But it's irrelevant if the worker dies before reaching that code.

---

## Hypotheses (Need Validation)

### H1: Cloudflare cron handler terminates early (HIGH confidence)

The `scheduled()` handler at line 304 takes `_ctx: ExecutionContext` -- underscore-prefixed, **never used**. `ctx.waitUntil()` is never called anywhere. Without it, CF may not know the handler needs extended execution time.

Cloudflare Workers Standard plan cron limits:
- CPU time: 30s
- Wall time: up to 15 min (but only guaranteed with `waitUntil`)

The run takes 15 min through MCP. Even with `waitUntil`, it's cutting it razor-thin.

**To validate:** Add `console.log` timestamps at each phase boundary, deploy, tail the next cron with `wrangler tail`, see where it dies.

### H2: MCP latency is the core performance problem (CONFIRMED)

Each MCP call: Worker (CF edge) -> Railway SSE -> Instantly API -> Railway -> Worker. Average 2-10s per call. ~380 calls per full run = 900s.

Direct Instantly API calls would be ~300ms each = ~120s total.

**To validate:** Already confirmed by comparing V1 (direct, 50s) vs V2 (MCP, 900s).

### H3: In-loop Supabase writes are also fire-and-forget (HIGH confidence)

Throughout index.ts, many writes lack `await`:
```typescript
if (sb) writeAuditLogToSupabase(sb, auditEntry).catch(...);  // No await
if (sb) writeNotificationToSupabase(sb, {...}).catch(...);     // No await
```

When the worker dies, these in-flight promises are abandoned. Explains why SOME audit_logs land (completed before death) while others don't.

**To validate:** Grep `index.ts` for `writeAuditLogToSupabase` and `writeNotificationToSupabase` -- check which have `await` and which don't.

### H4: KV writes may be failing silently in CF production (MEDIUM confidence)

KV is empty despite the worker supposedly writing dedup keys, rescan entries, etc. during the evaluation loop. Possible causes:
- KV namespace ID mismatch between wrangler.toml and what's actually deployed
- The `/__clear-v1-keys` endpoint was accidentally triggered
- KV writes fail in the CF edge environment but succeed locally

**To validate:**
1. Deploy a tiny test: write a known key at the START of the handler (before any evaluation), check if it persists
2. Check Cloudflare dashboard for the actual KV namespace bound to the production worker
3. Search Cloudflare Worker logs for any KV error messages

---

## Code Layout

All source: `/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off/src/`

| File | Lines | Role |
|------|-------|------|
| `index.ts` | 1904 | Main worker. `scheduled()` at line 304. Phases 1-8. |
| `supabase.ts` | ~100 | Supabase write helpers |
| `mcp-client.ts` | ~100 | MCP SSE client (10s connect timeout, 30s call timeout) |
| `instantly.ts` | ~200 | Instantly API via MCP |
| `config.ts` | ~200 | Workspace configs, pilot filter |
| `slack.ts` | ~300 | Slack notification functions (500ms + 1000ms sleeps per message) |
| `evaluator.ts` | ~100 | Variant evaluation logic |
| `thresholds.ts` | ~100 | Dynamic threshold resolution |
| `types.ts` | ~100 | Type definitions |
| `wrangler.toml` | 19 | Config: crons, KV namespace, env vars |

### Key wrangler.toml
```toml
name = "auto-turnoff"
crons = ["0 10,16,22 * * *"]
KV namespace = "c054b62e43b54a22bcc1ffa24bb72272"
DRY_RUN = "false"
KILLS_ENABLED = "false"
THRESHOLD = "4000"
CONCURRENCY_CAP = "5"
```

### Execution Flow
```
scheduled() [line 304]:
  1. Acquire lock (KV)
  2. Connect MCP (SSE to Railway, 10s timeout)
  3. listWorkspaces (MCP)
  4. FOR EACH workspace (sequential):
       getCampaigns (MCP)
       FOR EACH campaign (concurrent, cap=5):
         getCampaignDetails (MCP)        -- ~2-5s
         getStepAnalytics (MCP)          -- ~2-5s
         resolveThreshold (MCP or KV)    -- ~1-3s
         evaluate variants
         [if kill/block/warn]:
           write audit_log to Supabase   -- fire-and-forget (NO await)
           send Slack notification        -- awaited, 1.5s sleep per msg
           write notification to Supabase -- fire-and-forget (NO await)
  5. Rescan (Phase 2): check rescan: KV keys, re-evaluate
  6. Leads check (Phase 3): countLeads + getCampaignAnalytics per candidate
  7. Persistence monitor (Phase 4): verify kills stuck
  --- CRON DIES SOMEWHERE IN PHASES 1-4 ---
  8. Write daily_snapshot (KV + Supabase) -- NEVER REACHED
  9. Write run_summary (KV + Supabase)   -- NEVER REACHED
  finally:
     Release lock, close MCP
```

---

## How to Run an Invisible Test

An "invisible" run = processes everything normally, logs to Supabase, but sends NO Slack messages and doesn't kill anything.

**Option A: Local with wrangler dev (recommended)**
```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"

# 1. Temporarily set DRY_RUN=true in wrangler.toml (suppresses Slack + kills)
# 2. Run locally:
npx wrangler dev

# 3. In another terminal:
curl http://localhost:8787/__scheduled

# 4. Watch console output for errors, timing, KV write failures
# 5. After run completes, check Supabase for new run_summary with dry_run=true
# 6. Check KV: npx wrangler kv:key list --namespace-id c054b62e43b54a22bcc1ffa24bb72272 --prefix "run:"
# 7. RESTORE DRY_RUN=false in wrangler.toml when done
```

**Option B: Tail production cron**
```bash
npx wrangler tail auto-turnoff --format json
# Wait for next cron (6pm ET = 22:00 UTC today)
# Capture all console output to see where it dies
```

**Option C: Add a /\_\_silent-run endpoint** that forces DRY_RUN=true for a single invocation regardless of env var, so you can trigger against production without changing config.

---

## Draft Fix (From Previous Investigation)

A spec was already drafted at `specs/cron-timeout-fix-2026-03-19.md`. Key fixes in priority order:

### P0: Direct Instantly API Client
Create `src/instantly-direct.ts` -- bypass MCP entirely, call Instantly REST API directly. Drops run time from 900s to <120s. Draft implementation is in the spec file. **Needs validation:** compare MCP response shapes vs raw API response shapes for each endpoint.

New env: `INSTANTLY_API_KEY` (Cloudflare secret), `INSTANTLY_MODE` = `"direct"` | `"mcp"` (wrangler.toml var).

### P0: Use ctx.waitUntil()
```typescript
// Change line 304 from:
async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext)
// To:
async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext)
// And wrap the body in ctx.waitUntil()
```

### P1: Await ALL In-Loop Supabase Writes
~15 fire-and-forget writes in index.ts need `await` added. Full list of line numbers in the spec.

### P1: Add Observability
Structured JSON logs at each phase boundary + KV heartbeat every 10 campaigns.

### P2: Reduce Slack Sleeps
500ms + 1000ms per notification -> 200ms + 0ms. Saves ~28s per run.

### P2: Remove or Protect /__clear-v1-keys
Either delete the endpoint or add `?confirm=yes` gate.

---

## What You Should Do

1. **Read the full `index.ts`** scheduled handler (lines 304-1821) to understand the flow
2. **Grep for fire-and-forget writes** -- find every `writeAuditLogToSupabase`, `writeNotificationToSupabase`, `env.KV.put` without `await`
3. **Run an invisible local test** (Option A above) with extra console.log at phase boundaries to time each phase
4. **Validate H1**: Check if `ctx.waitUntil()` changes cron behavior. Quick test: add it, deploy, tail the next cron.
5. **Validate H4**: Write a test key to KV at the very start of `scheduled()`, then check from wrangler CLI if it persists
6. **Compare API response shapes**: Call one Instantly API endpoint directly (e.g., GET /api/v2/workspaces with Bearer token) and compare to what MCP returns for `list_workspaces`. Document any field mapping differences.
7. **Draft the fix** -- minimize changes. The direct API client is the big one. Everything else is small.
8. **Save your work** -- write the fix plan and any code to a spec file or branch. Do NOT deploy.

---

## Key Constraints

- **KILLS_ENABLED=false** -- nothing will be killed even if DRY_RUN=false
- **#cc-* channels are visible to CMs** -- don't trigger runs that spam Slack (use DRY_RUN=true for local tests)
- **The Instantly API key** is used across all workspaces. Check if it's already stored as a CF secret: `wrangler secret list`
- **Don't break the lock mechanism** -- if a run is in progress (check `lock` key in KV), wait or clear it manually
- **V1 data is unreliable** -- always filter `WHERE worker_version = 'v2'` in Supabase queries
