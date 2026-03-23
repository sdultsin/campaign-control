# Leads Cache Design: MCP count_leads KV Caching Strategy

**Date:** 2026-03-22
**Status:** Design (not yet implemented)
**Scope:** Phase 3 of `executeScheduledRun` in `src/index.ts`
**Context:** The existing batch-analytics path (deployed in `18aaf70`) already eliminates MCP for the standard leads check. This design addresses the future case where MCP `count_leads` is re-introduced for exact per-campaign lead status (including the `skipped` count), which is currently unavailable from the batch analytics endpoint.

---

## Background: Two Leads Paths

As of `18aaf70`, Phase 3 has two paths:

| Mode | Data source | Cost | Skipped count |
|------|-------------|------|---------------|
| `useDirectApi` (production) | `getBatchCampaignAnalytics` - 1 API call/workspace | ~200ms total | Not available (set to 0) |
| MCP fallback / `INSTANTLY_MODE=mcp` | `count_leads` per campaign via SSE | ~23s/campaign serialized | Exact |

The MCP path is preserved as a fallback and for correctness work (Outreachify investigation per active-context item #5). When MCP `count_leads` is called for 70 campaigns, total Phase 3 cost is **~27 minutes** — far exceeding Cloudflare's worker execution limit.

This design spec describes a KV caching layer that makes the MCP `count_leads` path viable at scale, while keeping the batch-analytics path as the fast default.

---

## Design Decisions

### TTL: 6 hours

- Runs are at 6am / 12pm / 6pm ET (10:00 / 16:00 / 22:00 UTC) — 6-hour intervals
- A 6-hour TTL means each run can serve the previous run's cache, and cache entries expire before they'd be reused a third time
- **Why not 12h or 24h:** Leads depletion is the whole point of this check. A CM uploading a large batch of leads (e.g., 10,000) mid-day would be invisible until the next run even without caching. With 24h TTL, a campaign exhausted at noon could still show as HEALTHY at 6pm. 6h matches the run cadence — worst case, one run stale, and the next run pays full cost
- **Configurable constant:** `LEADS_CACHE_TTL_SECONDS = 21600` in `config.ts`

### Cache key format

```
leads-cache:{campaignId}
```

- `campaignId` is the Instantly campaign UUID — already used as the unique identifier throughout the worker
- No workspace prefix needed: campaign IDs are globally unique across workspaces (they're UUIDs)
- Consistent with existing KV key patterns: `kill:{campaignId}`, `leads-exhausted:{campaignId}`, `leads-warning:{campaignId}`

### Smart invalidation: batch analytics delta check

The batch analytics endpoint is always called in direct mode (zero incremental cost — it runs regardless). Its `leads_count` field represents the total leads uploaded to the campaign.

**Rule:** If the batch analytics `leads_count` for a campaign differs from the cached `total_leads` by more than `LEADS_CACHE_DELTA_THRESHOLD` (default: 500), invalidate the cache entry before the MCP call.

This handles the "CM uploads 10,000 new leads" scenario: `leads_count` jumps from, say, 15,000 to 25,000. Delta is 10,000 > 500. Cache is busted. MCP `count_leads` is called fresh. The new `active` count (which reflects the uploaded leads) is returned and cached.

The delta check requires that `LeadsCacheEntry` stores `total_leads` (so we can compare). This is already captured from the MCP response.

### Stale-while-revalidate: no

The Worker is a single-threaded async executor. Cloudflare Workers do not support true background work within a cron handler outside of `ctx.waitUntil`. Adding SWR complexity is not warranted here — the rolling refresh pattern (below) achieves the same amortization goal more predictably.

### Rolling refresh: yes

Instead of refreshing all 70 campaigns on the first uncached run (70 x 23s = 27 min), refresh a fixed number of campaigns per run. The rest serve cached data.

**`LEADS_CACHE_REFRESH_BATCH_SIZE = 15`** per run (configurable in `config.ts`).

Selection priority for the batch slot:
1. Cache miss (no entry) — highest priority
2. Expired or within 1 hour of expiry
3. Batch analytics delta exceeded threshold — forced refresh regardless of TTL
4. Oldest cached entry (LRU-style: sort by `cachedAt` ascending)

At 15 refreshes per run x 23s each = 5.75 minutes for MCP calls. Well within the 30-minute worker limit. Remaining 55 campaigns serve cache.

**Ramp-up period:** On first deploy or after a cache flush, the first run only refreshes `LEADS_CACHE_REFRESH_BATCH_SIZE` campaigns. The rest receive `SKIPPED` status (not enough data). This is acceptable — the batch analytics path still runs for all campaigns as the depletion check. The cache only augments with the exact `skipped` count from MCP.

---

## Cache Schema

### Key

```
leads-cache:{campaignId}
```

Example: `leads-cache:24701edd-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### Value shape

```typescript
interface LeadsCacheEntry {
  campaignId: string;
  workspaceId: string;
  cachedAt: string;              // ISO 8601 timestamp of when MCP call was made
  expiresAt: string;             // ISO 8601 timestamp (cachedAt + TTL), for readable debugging
  totalLeads: number;            // From count_leads.total_leads — used for delta detection
  status: {
    completed: number;
    active: number;
    skipped: number;
    bounced: number;
    unsubscribed: number;
  };
  source: 'mcp-count_leads';     // Future-proofing: identifies which endpoint populated this
}
```

### TTL

```
expirationTtl: LEADS_CACHE_TTL_SECONDS  // 21600 = 6 hours
```

KV's native TTL handles expiration — no manual expiry logic needed. The `expiresAt` field in the value is for human readability in debugging only.

### KV put call

```typescript
await env.KV.put(
  `leads-cache:${campaignId}`,
  JSON.stringify(entry),
  { expirationTtl: LEADS_CACHE_TTL_SECONDS }
);
```

---

## Read/Write Flow (Pseudocode)

This describes the augmented Phase 3 logic. The batch analytics path remains unchanged and runs first. The cache layer wraps the MCP path.

### Pre-loop: build refresh queue

```
// Already fetched in existing Phase 3 setup:
leadsBatchByWorkspace: Map<workspaceId, Map<campaignId, batchData>>

// New: read all cache entries for candidates in parallel
cacheEntries: Map<campaignId, LeadsCacheEntry | null>
for each candidate in leadsCheckCandidates (parallel, batched):
    entry = await env.KV.get(`leads-cache:${candidate.campaignId}`, 'json')
    cacheEntries.set(candidate.campaignId, entry)

// Determine which campaigns need MCP refresh
refreshQueue: LeadsCheckCandidate[] = []
for each candidate in leadsCheckCandidates:
    cached = cacheEntries.get(candidate.campaignId)
    batchData = leadsBatchByWorkspace.get(candidate.workspaceId)?.get(candidate.campaignId)

    if cached is null:
        refreshQueue.push(candidate)  // cache miss
        continue

    if batchData exists:
        delta = abs(batchData.leads_count - cached.totalLeads)
        if delta > LEADS_CACHE_DELTA_THRESHOLD:
            refreshQueue.push(candidate)  // leads uploaded — bust cache
            continue

    // Check if within 1h of expiry (refresh-ahead)
    ttlRemaining = new Date(cached.expiresAt).getTime() - Date.now()
    if ttlRemaining < 3600_000:
        refreshQueue.push(candidate)  // near-expiry, proactive refresh

// Sort refresh queue: cache misses first, then oldest cachedAt
refreshQueue.sort(byPriority)

// Cap at LEADS_CACHE_REFRESH_BATCH_SIZE
mcpRefreshBatch = refreshQueue.slice(0, LEADS_CACHE_REFRESH_BATCH_SIZE)
```

### MCP refresh batch

```
if phase3McpApi is connected AND mcpRefreshBatch.length > 0:
    for each candidate in mcpRefreshBatch (serial, MCP is not parallelizable via SSE):
        try:
            leadCounts = await phase3McpApi.countLeads(candidate.workspaceId, candidate.campaignId)

            newEntry: LeadsCacheEntry = {
                campaignId: candidate.campaignId,
                workspaceId: candidate.workspaceId,
                cachedAt: now.toISOString(),
                expiresAt: (now + LEADS_CACHE_TTL_SECONDS * 1000).toISOString(),
                totalLeads: leadCounts.total_leads,
                status: leadCounts.status,
                source: 'mcp-count_leads',
            }

            await env.KV.put(
                `leads-cache:${candidate.campaignId}`,
                JSON.stringify(newEntry),
                { expirationTtl: LEADS_CACHE_TTL_SECONDS }
            )

            // Update in-memory map so the per-campaign loop below reads fresh data
            cacheEntries.set(candidate.campaignId, newEntry)

        catch mcpErr:
            leadsCheckErrors++
            console.warn(...)
            // Leave existing cache entry in place (do not evict on error)
```

### Per-campaign loop: serve from cache or fall through to batch

```
for each candidate in leadsCheckCandidates:
    cached = cacheEntries.get(candidate.campaignId)

    if cached exists (and not delta-busted):
        // Use cached MCP data (exact skipped count)
        totalLeads   = cached.totalLeads
        completed    = cached.status.completed
        active       = cached.status.active
        bounced      = cached.status.bounced
        skipped      = cached.status.skipped
        unsubscribed = cached.status.unsubscribed
        uncontacted  = active
        dataSource   = 'mcp-cached'

    else if batchData exists (direct mode fallback):
        // Cache miss AND not in mcpRefreshBatch (budget exhausted), or MCP failed
        totalLeads   = batchData.leads_count
        completed    = batchData.completed_count
        bounced      = batchData.bounced_count
        unsubscribed = batchData.unsubscribed_count
        skipped      = 0  // not available
        active       = max(0, totalLeads - completed - bounced - unsubscribed)
        uncontacted  = active
        dataSource   = 'batch-analytics'

    else:
        console.warn(`No data for campaign ${candidate.campaignId} — skipping`)
        continue

    // Existing evaluation and notification logic — unchanged
    result = evaluateLeadDepletion(uncontacted, candidate.dailyLimit, totalLeads)
    ...
    // Include dataSource in LeadsAuditEntry.leads.source field (already typed as optional)
```

---

## Smart Invalidation Rules

| Trigger | Action | Rationale |
|---------|--------|-----------|
| `abs(batch.leads_count - cached.totalLeads) > 500` | Force refresh in current run (add to mcpRefreshBatch) | CM uploaded leads; stale cache would cause false HEALTHY |
| Cache entry age > 6h (KV TTL expired) | Natural expiry; KV returns null; treated as cache miss | No manual tracking needed |
| Cache entry within 1h of expiry | Proactive refresh (second-priority in queue) | Prevents all 70 entries expiring simultaneously on the same run |
| MCP `count_leads` returns error | Keep existing cache entry, increment leadsCheckErrors | Better stale data than no data |
| Worker deploy / new campaign added | Cache miss on first encounter | Natural handling; no special case needed |
| CM marks campaign as finished (all leads contacted) | Batch analytics `leads_count` may show 0 active → delta fires | Or `evaluateLeadDepletion` returns SKIPPED on zero total; no stale problem |

### What does NOT invalidate the cache

- Variant kills / Phase 2 activity — irrelevant to lead counts
- `leads-exhausted:` or `leads-warning:` dedup key writes — those are notification dedup, not data
- Runs where MCP is unavailable — cache serves stale data; batch analytics provides fallback

---

## Integration Points with Existing Phase 3 Code

All line numbers reference `src/index.ts` at version `18aaf70`.

| Location | Line range | Change |
|----------|------------|--------|
| `config.ts` | After line 120 (LEADS_EXHAUSTED_DEDUP_TTL_SECONDS) | Add `LEADS_CACHE_TTL_SECONDS`, `LEADS_CACHE_DELTA_THRESHOLD`, `LEADS_CACHE_REFRESH_BATCH_SIZE` constants |
| `types.ts` | After `LeadsCheckCandidate` (line 41) | Add `LeadsCacheEntry` interface |
| `index.ts` — Phase 3 setup | Line 1499-1517 (Phase 3 MCP connect block) | No change to MCP setup; cache read runs in parallel after MCP connect attempt |
| `index.ts` — after batch analytics fetch | Line 1544 (after `leadsBatchByWorkspace` population) | Insert: parallel KV reads for all candidate cache entries; build `refreshQueue`; run serial MCP refresh batch |
| `index.ts` — per-campaign loop | Line 1547 (`for (const candidate of leadsCheckCandidates)`) | Replace the three-branch data fetch (phase3McpApi / useDirectApi / mcp-only) with cache-first logic; batch analytics becomes the fallback instead of one branch |
| `index.ts` — audit entry construction | Lines 1640, ~1700, ~1760 (EXHAUSTED / WARNING / RECOVERED audit entries) | Add `source: dataSource` to `leads` object (field already typed as optional in `types.ts` line 92) |
| `index.ts` — run summary logging | Line 2156 (`leadsChecked`) | Add `leadsCacheHits`, `leadsCacheMisses`, `leadsCacheRefreshed` counters to run summary for observability |

---

## Estimated Time Savings Per Run

### Steady state (after ramp-up)

| Scenario | Before cache | After cache |
|----------|-------------|-------------|
| 70 campaigns, all MCP (mcp-only mode) | 70 x 23s = **27 min** | 15 x 23s + overhead = **~6 min** |
| 70 campaigns, direct + MCP augmentation | ~15 MCP calls (partial) | same: **~6 min** |
| 70 campaigns, 5 delta-triggered invalidations | 70 x 23s = **27 min** | (15 + 5) x 23s = **~8 min** |

### First run after deploy (cold cache)

| Scenario | Cost |
|----------|------|
| 15 campaigns refreshed, 55 cache-miss fallback to batch | 15 x 23s = **~6 min** (55 serve batch) |
| After 5 runs (5 x 15 = 75, all campaigns cached) | Steady state reached |

### Cloudflare worker limit headroom

Cloudflare Cron Workers have a **30-second CPU time limit** but a **much higher wall-clock limit** (up to 15 minutes for paid plans, 30 minutes for Workers Unbound). The existing run at `18aaf70` with batch-only takes ~2-3 minutes. Adding 15 MCP calls at 23s each brings worst-case to ~8-9 minutes — well within limits.

The previous crash (before `18aaf70`) was caused by 70 serial MCP calls hitting the wall-clock limit, not the CPU limit. 15 calls is the safe ceiling.

---

## What This Design Does NOT Change

- The batch analytics path (`getBatchCampaignAnalytics`) runs regardless — it is the leads data source for the CM supervision console dashboard and the fast fallback
- KV dedup keys `leads-exhausted:`, `leads-warning:` — unchanged
- Slack notification format — unchanged
- `evaluateLeadDepletion` in `leads-monitor.ts` — pure function, source-agnostic
- Supabase `leads_audit_logs` schema — unchanged (the `source` field is already typed as optional in `LeadsAuditEntry`)
- The Phase 3 MCP connection attempt is opportunistic (fails gracefully to batch) — unchanged

---

## Open Questions (Resolve Before Implementation)

1. **Is MCP count_leads re-introduction actually needed?** Active-context item #5 asks Outreachify what endpoint their MCP server hits. If they expose a direct REST endpoint for exact lead status (including skipped), the cache design simplifies: replace MCP calls with direct HTTP calls inside the refresh batch, which are ~5x faster (~4-5s each vs 23s). The cache schema and invalidation logic are identical.

2. **LEADS_CACHE_REFRESH_BATCH_SIZE = 15 — verify against actual run duration.** At 23s/call, 15 calls = 5.75 minutes. If run time including Phase 1/2 is already 4-5 minutes, total becomes ~10 minutes. Need to verify current run duration from `run_summaries.duration_ms` before finalizing this constant.

3. **Parallel KV reads at scale.** 70 `env.KV.get()` calls in parallel (Promise.all) is fine for Cloudflare — KV reads are fast (~1-5ms each from the same datacenter). No concern, but worth confirming against Cloudflare KV rate limits (100k reads/day on free plan; 10M/day on paid).
