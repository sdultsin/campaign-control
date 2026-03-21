# Cron Timeout Fix: Implementation Complete — Handoff Back

**Date:** 2026-03-19
**Status:** All 7 fixes implemented. TypeScript compiles clean. NOT DEPLOYED.

---

## What Was Done

A new Claude Code instance received `cc-data-loss-handoff.md` and `cron-timeout-fix-2026-03-19.md`, validated all hypotheses against the actual code, and implemented every fix from the spec.

### Hypothesis Validation

| Hypothesis | Verdict | Evidence |
|-----------|---------|----------|
| H1: CF cron terminates early (no `waitUntil`) | **CONFIRMED** | `_ctx: ExecutionContext` at line 304, never used anywhere. Zero calls to `ctx.waitUntil()` in codebase. |
| H2: MCP latency = 50x slowdown | **CONFIRMED** | Every API call routes Worker→Railway SSE→Instantly→Railway→Worker. 900s vs 50s proven by local vs cron data. |
| H3: Fire-and-forget Supabase writes | **CONFIRMED** | Found **19** instances of `writeAuditLogToSupabase`, `writeNotificationToSupabase`, `writeLeadsAuditToSupabase` without `await`. All using `.catch()` pattern (promise created, never awaited, abandoned on worker death). |
| H4: KV empty / writes failing silently | **LIKELY** | Cron dies before end-of-run KV writes (lines 1765-1806). `/__clear-v1-keys` had zero protection (no confirmation, no logging). KV heartbeat added to diagnose further. |

### Files Changed

| File | What Changed |
|------|-------------|
| `src/instantly-direct.ts` | **NEW FILE.** Direct Instantly REST API client. Same method signatures as `InstantlyApi` (MCP-based). Implements: `listWorkspaces`, `getCampaigns`, `getCampaignDetails`, `getStepAnalytics`, `countLeads`, `getCampaignAnalytics`, `listAccounts`, `getAccount`, `enableVariant`, `disableVariant`, `updateCampaign`. |
| `src/index.ts` | 6 changes: (1) `scheduled()` now uses `ctx.waitUntil()` — body extracted to standalone `executeScheduledRun()`. (2) API client swap based on `INSTANTLY_MODE` env var. (3) All 19 Supabase writes now `await`ed. (4) Structured JSON logging at run_start, workspace_complete, and each phase boundary. (5) KV heartbeat every 10 campaigns. (6) Batch kill `update_campaign` call uses direct API when available. (7) `fetch()` handler rebuilt — `/__clear-v1-keys` now requires `?confirm=yes`. (8) Concurrency bumped to 10 (cap 15) in direct mode vs 3 (cap 5) in MCP mode. |
| `src/types.ts` | Added `INSTANTLY_API_KEY: string` and `INSTANTLY_MODE: string` to `Env` interface. |
| `src/thresholds.ts` | Removed `import type { InstantlyApi }`. Created `ThresholdApi` interface with `listAccounts` + `getAccount` signatures. Both `InstantlyApi` and `InstantlyDirectApi` satisfy it structurally. |
| `src/slack.ts` | `postThreadedMessage()`: sleep between title/detail reduced 500ms→200ms. Post-detail 1000ms sleep removed entirely. Failed-title 1000ms sleep removed. |
| `wrangler.toml` | Added `INSTANTLY_MODE = "direct"` to `[vars]`. |

### Architecture Decision: `executeScheduledRun()`

The `scheduled()` handler was too large to wrap inline with `ctx.waitUntil()`. Extracted the entire body into a standalone `async function executeScheduledRun(env: Env)`. The `scheduled()` handler now does three things:
```typescript
const runPromise = executeScheduledRun(env);
ctx.waitUntil(runPromise);
await runPromise;
```
The `fetch()` handler's `/__scheduled` endpoint calls the same function (no more `this.scheduled()` self-call).

### What Was NOT Changed

- `src/instantly.ts` — MCP-based client untouched (kept as fallback via `INSTANTLY_MODE=mcp`)
- `src/mcp-client.ts` — Untouched
- `src/revert.ts` — Uses MCP directly for its HTTP endpoint, not cron-critical
- `src/evaluator.ts`, `src/config.ts`, `src/leads-monitor.ts`, `src/dashboard.ts` — No changes needed
- `serveBaseline()` in index.ts — Still uses MCP (manual endpoint, not cron-critical)

---

## What You Need To Do Before Deploying

### 1. Set the Instantly API key as a Cloudflare secret

```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
npx wrangler secret put INSTANTLY_API_KEY
# Paste the Renaissance Instantly API key when prompted
```

If you don't know where the API key is: check if it's already a CF secret (`wrangler secret list`), or find it in the Instantly dashboard under Settings → API.

### 2. Verify API response shapes (CRITICAL)

The direct API client assumes Instantly V2 REST responses have the same field names the MCP server returns. The MCP server *may* transform responses. Before deploying, run one test call per endpoint and compare:

```bash
# Example: list workspaces
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "https://api.instantly.ai/api/v2/workspaces"
```

Compare the response shape to what `list_workspaces` returns via MCP. The `extractArray()` helper in `instantly-direct.ts` handles both `[...]` and `{ items: [...] }` / `{ workspaces: [...] }` wrappers, but field names (e.g., `id`, `name`) must match.

Endpoints to verify:
- `GET /workspaces` → `list_workspaces`
- `GET /campaigns?workspace_id=X&status=active` → `get_campaigns`
- `GET /campaigns/{id}?workspace_id=X` → `get_campaign_details`
- `GET /campaigns/analytics/steps?campaign_id=X&include_opportunities_count=true` → `get_step_analytics`
- `GET /accounts?workspace_id=X&tag_ids=Y` → `list_accounts`
- `GET /accounts/{email}?workspace_id=X` → `get_account`

### 3. Local test with DRY_RUN=true

```bash
cd "/Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off"
# wrangler.toml already has DRY_RUN=false — temporarily set to true
# Also need INSTANTLY_API_KEY available locally:
# Option A: .dev.vars file with INSTANTLY_API_KEY=xxx
# Option B: wrangler secret (already deployed) works with wrangler dev --remote

npx wrangler dev
# In another terminal:
curl http://localhost:8787/__scheduled
```

**Verify:**
- All 65 campaigns processed (check console output)
- `run_summary` written to Supabase (`WHERE worker_version = 'v2'` and today's date)
- `daily_snapshot` written to Supabase
- Duration < 120s (vs 900s before)
- Structured JSON logs appear: `run_start`, `workspace_complete`, `phase_start` events
- KV `heartbeat` key exists: `npx wrangler kv:key get heartbeat --namespace-id c054b62e43b54a22bcc1ffa24bb72272`

### 4. Deploy and tail

```bash
npx wrangler deploy
npx wrangler tail auto-turnoff --format json
# Wait for next cron (6pm ET = 22:00 UTC today)
```

After the cron fires, verify:
- Structured logs show all phases completing
- `run_summary` appears in Supabase
- `daily_snapshot` appears in Supabase
- KV `heartbeat` key exists
- Duration < 120s

### 5. Fallback plan

If direct API doesn't work (response shape mismatch, auth issue), change `wrangler.toml`:
```toml
INSTANTLY_MODE = "mcp"
```
and redeploy. Everything reverts to the old MCP path. The `ctx.waitUntil()` and `await` fixes still help even in MCP mode.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| API response shape mismatch | Medium | `extractArray()` handles common wrappers. Verify step 2 above. Fallback to MCP mode. |
| API key wrong/expired | Low | Check `wrangler secret list`. Test with curl first. |
| Rate limiting on direct API | Low | Concurrency capped at 10. Instantly V2 is generous. Same total calls as MCP mode. |
| `ctx.waitUntil()` doesn't extend cron lifetime | Low | Even if CF still kills at 15min, direct API finishes in <2min. `waitUntil` is belt-and-suspenders. |
| Supabase writes slower with `await` | Negligible | ~50-200ms each, ~20 writes = 1-4s total. Irrelevant vs 900s→120s savings. |

---

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Cron run duration | 900s (15 min, dies mid-run) | ~60-120s (completes) |
| Audit logs per cron | 1-8 (partial) | ~266 (all) |
| run_summary written | Never (cron dies first) | Every run |
| daily_snapshot written | Never | Every run |
| KV state | Empty | Populated (heartbeat, dedup keys, snapshots) |
| Slack notification overhead | ~33s sleeping | ~4s sleeping |
