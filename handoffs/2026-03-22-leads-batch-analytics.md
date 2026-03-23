# Handoff: Phase 3 Leads Monitoring - Batch Analytics

**Version:** `18aaf70`
**Deployed:** 2026-03-22 ~22:45 UTC
**Spec:** `specs/2026-03-22-leads-direct-api.md` (partially implemented -- endpoint discovery deferred)

---

## What changed

Phase 3 leads monitoring switched from per-campaign MCP `countLeads()` to batch direct API analytics.

**Before (1802bf2 -> 153b508):** Each candidate campaign called `mcpApi.countLeads()` via MCP SSE. MCP SSE from Cloudflare Workers to Railway fails on every call. Result: `leads_checked=0`, `leads_check_errors=N` on every run since 1802bf2.

**After (18aaf70):** Before the candidate loop, fetches `getBatchCampaignAnalytics()` once per workspace (1 API call each). Each candidate looks up its data from the batch Map. Computes `active = leads_count - completed_count - bounced_count - unsubscribed_count`, clamped to >= 0.

## Files changed

- `src/index.ts` -- Phase 3 only. Added batch fetch before loop (lines 1505-1523). Replaced MCP countLeads with dual-path: direct API batch lookup (production) or MCP fallback (non-direct mode). Updated error log messages.

## Data accuracy

**What's accurate:**
- `leads_count` (totalLeads) -- confirmed matches MCP `count_leads.total_leads` and Instantly UI
- `completed_count`, `bounced_count`, `unsubscribed_count` -- from the same batch analytics endpoint

**What's approximate:**
- `active` -- derived as `leads_count - completed - bounced - unsubscribed`. Missing `skipped` (typically <0.1% of total). May be understated if status fields are lifetime accumulators (same class of bug as `contacted_count`).
- `skipped` -- set to 0 in all audit entries (not available from analytics endpoint)

**Error direction:** If the formula is wrong, `active` is understated (more false EXHAUSTED/WARNING). CMs get extra alerts they can dismiss. This is safer than the previous state (0 leads monitored).

## Why not the original spec approach

The spec (`2026-03-22-leads-direct-api.md`) called for finding a direct `/leads/count` endpoint. Extensive API probing confirmed:
- `GET /leads/count` -- 404 (routes to `/leads/:id` with id="count")
- `POST /leads/count` -- 404
- `POST /leads/list` -- cursor pagination only, no `total_count` field
- `GET /campaigns/analytics/overview` -- email metrics only, no lead counts
- `GET /api/v1/lead/count` -- exists but requires undocumented `by` + `list_id` params
- MCP server -- SSE only, no HTTP transport

The MCP `count_leads` tool works perfectly but can't be called from Cloudflare Workers. It likely queries Outreachify's Supabase (synced lead data) or uses an internal Instantly endpoint. **Action needed: ask Outreachify what endpoint their MCP server uses for `count_leads`.**

## What to watch

1. **Next cron run:** `leads_checked` should be > 0 (was 0 since `1802bf2`), `leads_check_errors` should be 0
2. **False EXHAUSTED/WARNING:** Compare a few campaigns against Instantly UI. If campaigns with plenty of active leads show as EXHAUSTED, the analytics fields are lifetime accumulators and we need the real endpoint from Outreachify.
3. **Recovery floods:** Previously-alerted campaigns (from `1802bf2` era) with expired dedup keys may trigger fresh EXHAUSTED/WARNING/RECOVERED notifications.

## Verification queries

```sql
-- Check leads monitoring is working
SELECT leads_checked, leads_check_errors, errors, worker_version
FROM run_summaries
WHERE worker_version = '18aaf70'
ORDER BY created_at DESC LIMIT 3;

-- Check audit entries have real data
SELECT campaign_name, action, leads->>'total' as total, leads->>'active' as active,
       leads->>'completed' as completed, leads->>'bounced' as bounced
FROM leads_audit_logs
WHERE worker_version = '18aaf70'
ORDER BY created_at DESC LIMIT 10;
```

## Next steps

1. **Ask Outreachify** what Instantly API endpoint their MCP server calls for `count_leads` (the tool that returns `total_leads` + status breakdown). If it's a v1 endpoint or internal endpoint, we can call it directly.
2. **If endpoint found:** Replace the batch analytics formula with a direct call in `countLeads()` method of `instantly-direct.ts`.
3. **If no endpoint exists:** The MCP server may count from its own Supabase. In that case, consider: (a) adding an HTTP endpoint to the MCP server, or (b) querying Outreachify's Supabase directly if accessible.
