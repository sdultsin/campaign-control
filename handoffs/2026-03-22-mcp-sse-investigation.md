# MCP SSE from Cloudflare Workers - Investigation Results

**Date:** 2026-03-22
**Status:** Investigation complete. SSE works. Performance bottleneck identified.

## TL;DR

SSE from CF Workers to Railway MCP server **works perfectly**. The connection was never broken -- it was just never attempted in `INSTANTLY_MODE=direct`. The real problem is `count_leads` takes **23 seconds per campaign** via MCP, which makes per-campaign calls infeasible at scale (~70 campaigns x 23s = 27 minutes, exceeds 15-minute cron wall time).

## Test Results

Deployed a standalone test Worker (`mcp-sse-test`) that exercised the full MCP protocol:

| Step | Result | Duration |
|------|--------|----------|
| SSE GET connect | OK | 79ms |
| Endpoint event received | OK | <1ms |
| MCP initialize handshake | OK | 16ms |
| notifications/initialized | OK | 54ms |
| list_workspaces tool call | OK | 11ms |
| count_leads tool call | OK | **23,202ms** |
| Close | OK | <1ms |

**Total round trip: 23.4 seconds** (dominated entirely by count_leads).

The first test run (without campaign ID) completed in 118ms -- proving SSE connect, stream reading, pump loop, and JSON-RPC all work from CF Workers edge.

## Why It Was Broken Before

1. `index.ts` line 496: `if (!useDirectApi) { await mcp.connect(); }` -- MCP connect was skipped entirely in direct mode
2. This was added intentionally after MCP SSE was assumed broken (based on earlier failures when both Phase 1 API calls AND MCP were competing for connections)
3. The earlier failures were likely the 30-second `callTool` timeout being hit by the 23-second `count_leads` response time, not an SSE transport issue

## The Real Problem: count_leads Performance

`count_leads` via MCP takes ~23 seconds per campaign. This is the MCP server calling the Instantly v1 API internally, which paginates through all leads to count them.

**At scale:**
- 70 active campaigns x 23s = **~27 minutes** (exceeds 15-minute cron wall time)
- Even with 3x concurrency: ~9 minutes just for leads (leaves 6 minutes for Phase 1 + 2)
- Serial processing is not viable

## Current State (deployed `18aaf70`)

Phase 3 uses **batch analytics** (`GET /campaigns/analytics`, 1 call per workspace) which returns `leads_count`, `completed_count`, `bounced_count`, `unsubscribed_count`. We compute: `active = leads_count - completed - bounced - unsubscribed`.

**Pros:** Fast (1 call per workspace, ~200ms each), no MCP dependency
**Cons:** Fields may be lifetime accumulators (lead cycling inflates completed_count, understating active). `skipped` count unavailable. False EXHAUSTED alerts possible but safe direction.

## Options Going Forward

### Option A: Hybrid approach (recommended)
Keep batch analytics as default. Use MCP `count_leads` only for campaigns flagged as WARNING or EXHAUSTED by batch analytics (validation pass). If batch says EXHAUSTED but MCP says HEALTHY, trust MCP. This limits MCP calls to 5-10 per run max.

### Option B: Durable Objects SSE proxy
Code is written (`src/mcp-durable-object.ts`, `src/mcp-do-client.ts`, `specs/mcp-durable-object-integration.md`). The DO maintains a persistent SSE connection with unlimited wall time. The cron Worker delegates MCP calls to the DO. This doesn't solve the 23s-per-call latency but removes the cron wall time constraint for DO-mediated calls.

### Option C: Ask Outreachify for faster endpoint
The MCP server's `count_leads` calls the Instantly v1 API which paginates all leads. If Outreachify exposed a direct v2 endpoint or cached the count, it could be sub-second. This is the Thomas/Daniel question.

### Option D: Bump timeout + parallelize MCP calls
Set `count_leads` timeout to 60s. Run 3-5 MCP calls in parallel (within 6-connection limit). Would bring ~70 campaigns down to ~8 minutes. Tight but feasible within 15-minute wall time. Risk: Railway server may not handle concurrent sessions well.

## Files Created During Investigation

- `src/mcp-test.ts` -- standalone SSE connectivity test Worker (test complete, Worker deleted)
- `src/mcp-durable-object.ts` -- Durable Object SSE proxy class (Path 2, ready to wire in)
- `src/mcp-do-client.ts` -- drop-in McpClient replacement using DO (Path 2)
- `specs/mcp-durable-object-integration.md` -- wrangler.toml + types.ts + index.ts changes for DO

## Decision Needed

Which option to implement for accurate lead counts? Recommendation is **Option A** (hybrid: batch analytics + MCP validation for flagged campaigns only). Limits MCP calls to ~5-10 per run, stays well within wall time, and gives accurate counts where it matters most (campaigns about to be flagged EXHAUSTED).
