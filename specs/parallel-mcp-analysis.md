# Parallel MCP SSE Connection Analysis

**Date:** 2026-03-22
**Question:** Can we open multiple SSE connections to the Railway MCP server simultaneously from one Worker invocation, and would it be faster than the current serial approach?

---

## Current State of Phase 3 (as-deployed)

The current code (`INSTANTLY_MODE=direct`) uses a **two-pass hybrid**:

- **Pass 1:** Batch analytics API - 1 call per workspace, ~17 calls total, fast (~200ms each). Screens all ~70 candidates using `contacted_count` (which is known to be a lifetime accumulator - see lead-count-diagnosis.md).
- **Pass 2:** A single `McpClient` SSE session opened **only if** Pass 1 flagged any campaigns as WARNING or EXHAUSTED. Calls `count_leads` per flagged campaign via MCP to validate the batch verdict. Typically 5-15 campaigns in this queue.

The 23s-per-campaign figure and 70-campaign serial scenario described in the task prompt reflect a hypothetical where **all 70 campaigns** go through MCP `count_leads`. That is not the current architecture. Under the current two-pass model:

- MCP is only used for flagged campaigns (~5-15, not 70)
- Pass 2 with 10 flagged campaigns at 23s each = ~3.8 minutes serial

However, the 23s/call timing is relevant if we move to a full MCP pass (which would be needed to fix the `contacted_count` bug correctly - see the lead-count-fix spec). This analysis therefore addresses both the current partial-MCP scenario and the full-MCP scenario.

---

## Connection Budget Analysis

### Cloudflare Workers limit: 6 simultaneous outbound connections

This limit applies per Worker invocation. A connection slot is held for the duration of a fetch() that is in-flight (not yet resolved).

### Connection inventory during Phase 3

**At Phase 3 start (direct mode):**

| Connection | Status | Count |
|-----------|--------|-------|
| Main MCP client (mcp.connect()) | Never opened in direct mode | 0 |
| Supabase client | Uses keep-alive HTTP/1.1 or HTTP/2; individual requests open/close slots sequentially. No persistent slot held between awaited calls. | 0 between awaits |
| KV reads/writes | CF internal, does NOT consume outbound connection slots | 0 |
| Slack | Not called during the Phase 3 per-campaign loop. `collector.add()` is in-memory only. Flush happens in Phase 5 (after Phase 3). | 0 |
| Batch analytics pre-fetch (lines 1532-1543) | Completes and closes BEFORE the MCP session opens. Sequential, not overlapping. | 0 |

**During Pass 2 MCP loop:**

| Connection | Status | Count |
|-----------|--------|-------|
| Phase 3 SSE GET (persistent) | Open for duration of loop | 1 |
| Active POST (per count_leads call) | Open only while awaiting response | 0-1 |
| Supabase writes (per verdict) | Sequential, open/close within each await | 0-1 |

**Peak connections during current single-session Pass 2:** 1 SSE GET + 1 POST + 1 Supabase write = 3. Well within the 6-connection limit.

### Connection math for parallel sessions

Each MCP session requires:
- 1 persistent SSE GET (open for the entire session lifetime)
- 1 POST at a time during active callTool() calls
- 1 initialize POST (during connect() phase, then released)

**2 parallel sessions:**
- 2 SSE GETs (persistent) + up to 2 concurrent POSTs = 4 connections peak
- Add 1 for any in-flight Supabase write = 5 total
- Headroom: 1 connection spare
- **SAFE**

**3 parallel sessions:**
- 3 SSE GETs (persistent) + up to 3 concurrent POSTs = 6 connections
- Add 1 for any in-flight Supabase write = **7 total — EXCEEDS LIMIT**
- If a Supabase write fires while all 3 MCP sessions are mid-POST, CF would either queue or drop the Supabase fetch
- **NOT SAFE without disabling Supabase writes during the MCP loop**

**Verdict: 2 parallel sessions is the safe maximum.**

### Important caveat: connect() phase

During `p3mcp.connect()`, the McpClient sends:
1. SSE GET (persistent)
2. POST initialize request

If you connect 2 sessions simultaneously (both in `await Promise.all([s1.connect(), s2.connect()])`), the peak during connect is:
- 2 SSE GETs + 2 initialize POSTs = 4 connections
- This is fine

If you connect 3 simultaneously: 3 SSE + 3 POSTs = 6 - no Supabase room.

---

## Session Independence: Will It Work?

Each SSE connection to the Railway MCP server receives a unique session ID (UUID) and a unique POST endpoint (`/messages/{uuid}`). Sessions are stateless with respect to each other on the server side. There is no cross-session locking.

The McpClient class is already fully self-contained per instance:
- Separate `reader`, `abortController`, `endpoint`, and `pending` map per instance
- `nextId` counter is per-instance (no global ID collisions across sessions)
- No shared state in the class between instances

**Conclusion: Multiple simultaneous McpClient instances pointing to the same Railway server will work correctly. Each gets its own session, own POST endpoint, own pending response queue.**

---

## Timing Analysis

### Scenario A: Current partial-MCP (hybrid, only flagged campaigns)

Assuming ~10 campaigns in the MCP validation queue (typical for current runs):

| Mode | Math | Wall time |
|------|------|-----------|
| Serial (1 session) | 10 x 23s | ~3.8 min |
| 2 parallel sessions | 5 x 23s | ~1.9 min |
| Connect overhead | 2 sessions x ~200ms | ~0.4s (negligible) |

For ~10 campaigns, parallelism saves ~2 minutes. Not urgent. The current approach completes in under 4 minutes, well within the 15-minute cron wall time.

### Scenario B: Full MCP (all ~70 candidates, as in lead-count-fix spec)

If the lead-count-fix is deployed (switching from batch analytics to per-campaign count_leads for all candidates):

| Mode | Math | Wall time | Fits in 15 min? |
|------|------|-----------|-----------------|
| Serial (1 session) | 70 x 23s | 26.8 min | **NO** |
| 2 parallel sessions | 35 x 23s + 0.4s | 13.5 min | **YES, barely** |
| 3 parallel sessions (unsafe) | 24 x 23s + 0.6s | 9.2 min | YES |

**For Scenario B, 2 parallel sessions is necessary and sufficient.** Without it, the full-MCP approach cannot fit in the 15-minute cron window.

### Where does the 23s figure come from?

The 23s is inferred from the prior investigation that found MCP round-trips take 2-10s each, with Railway idle timeouts and Railway-to-Instantly latency compounding. The `count_leads` tool is a single-call operation so 23s is a conservative upper bound. In practice, individual calls may be 5-15s, with occasional slow outliers. Using 23s for planning purposes is correct.

---

## Proposed Parallel Architecture

### Design

Open 2 McpClient sessions at the start of Phase 3, partition campaigns round-robin, run both loops concurrently via `Promise.all()`.

```typescript
// Open 2 sessions simultaneously
const [sessionA, sessionB] = await Promise.all([
  openMcpSession(),  // returns { mcp: McpClient, api: InstantlyApi } or null
  openMcpSession(),
]);

// Partition campaigns round-robin
const queueA = campaigns.filter((_, i) => i % 2 === 0);
const queueB = campaigns.filter((_, i) => i % 2 === 1);

// Run both loops concurrently
const [resultsA, resultsB] = await Promise.all([
  processQueue(queueA, sessionA),
  processQueue(queueB, sessionB),
]);

// Close both
await Promise.all([sessionA?.mcp.close(), sessionB?.mcp.close()]);
```

### Partition strategy: round-robin vs. by-workspace

**Round-robin** is simpler and produces balanced queues regardless of workspace distribution. Each session processes ~35 campaigns.

**By-workspace** would mean session A handles workspaces 1-9, session B handles 10-18. This is slightly worse because workspace sizes vary (some have 10 campaigns, some have 2). Round-robin produces more balanced load.

**Recommendation: round-robin.**

### Error handling

If one session's SSE connection drops mid-loop (Railway idle timeout, Railway restart):
- The failing session's McpClient will reject all pending calls with "SSE stream closed"
- The surviving session continues processing its half
- Lost campaigns from the dead session: fall back to the batch analytics verdict for those campaigns (the same fallback that exists today for individual call failures)

Optional: redistribute remaining campaigns from the dead session to the surviving session. This adds complexity and is probably not needed — batch fallback is accurate for non-cycled campaigns.

**Recommendation: accept batch fallback on session death. Don't redistribute.**

### Session connection lifecycle

```
Phase 3 start:
  → connect session A and B in parallel (2 SSE GETs + 2 init POSTs = 4 connections)

Phase 3 MCP loop:
  → session A: 35 sequential count_leads calls (1 SSE GET + 1 POST per call = 2 per session)
  → session B: 35 sequential count_leads calls (same)
  → Both loops run concurrently via Promise.all
  → At any moment: 2 SSE GETs + up to 2 active POSTs + 1 Supabase write = 5 connections max

Phase 3 end (finally block):
  → close session A and B in parallel
  → SSE GET connections released
```

---

## Decision Matrix

| Scenario | Recommendation | Rationale |
|----------|---------------|-----------|
| Current hybrid (batch + MCP for flagged only, ~10 campaigns) | **Don't parallelize yet** | Serial Pass 2 takes ~4 min. Total run well under 15 min. Complexity not justified. |
| Full MCP on all ~70 candidates (lead-count-fix deployed) | **Parallelize with 2 sessions** | Serial = 27 min, exceeds cron limit. 2 sessions = 13.5 min, fits. This is the enabling condition. |
| Future scaling (>90 campaigns) | **Re-evaluate** | At 90 campaigns, 2 sessions = 90/2 x 23s = 17 min. May need 3 sessions, which requires disabling Supabase writes during MCP loop (feasible). |

---

## Alternative: Direct API countLeads (No MCP Needed)

The cleanest solution to the timing problem is to implement `countLeads` in `InstantlyDirectApi` correctly via the Instantly REST API, eliminating MCP from Phase 3 entirely.

The existing `InstantlyDirectApi.countLeads()` (lines 132-159) is a stub that calls `/leads?limit=0` and gets no status breakdown. The real endpoint needed is `GET /api/v2/leads/count` with `campaign_id` and `workspace_id` params — the same endpoint the MCP `count_leads` tool wraps.

**If direct API countLeads works:**
- 70 campaigns x ~300ms per direct API call = ~21 seconds total (no parallelism needed)
- No SSE connection budget concerns whatsoever
- Zero cron timeout risk

**Investigation needed:** Verify that `GET /api/v2/leads/count?workspace_id=X&campaign_id=Y` returns the full status breakdown (`active`, `completed`, `bounced`, `skipped`, `unsubscribed`). If it does, this is strictly better than parallel MCP and should be implemented first.

The MCP server source at `king-instantly-mcp-production.up.railway.app` can be checked to see what REST endpoint it calls under `count_leads`.

---

## Recommendation Summary

1. **Before building parallel MCP:** Verify whether `GET /api/v2/leads/count` returns status breakdowns. If yes, implement direct API `countLeads` — this eliminates the MCP bottleneck entirely at ~21s total vs ~13.5 min for 2 parallel MCP sessions.

2. **If direct API does not return status breakdowns:** Implement 2 parallel MCP sessions when the lead-count-fix is deployed. The connection budget supports exactly 2. Use round-robin partitioning. Accept batch fallback on session death.

3. **Do not attempt 3 parallel MCP sessions** without first disabling Supabase writes during the MCP loop or buffering them to a post-loop flush. The 6-connection ceiling is hard.

4. **Do not change anything for the current hybrid architecture** — Pass 2 processes only ~10 flagged campaigns and completes in ~4 minutes. Parallelism adds complexity without meaningful benefit at this scale.
