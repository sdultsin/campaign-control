# Handoff: Leads Direct API (Remove MCP Dependency)

**Date:** 2026-03-20
**Spec:** `specs/cc-leads-direct-api.md`
**Review:** APPROVED (all 8 checklist items pass)
**TypeScript:** PASS

## What the spec asked for

Remove MCP dependency from Phase 3 (leads depletion monitor). The 6am cron on 2026-03-20 crashed because serialized MCP calls through Railway SSE consumed enough wall-clock time to hit the CF worker execution limit. The worker was hard-killed mid-Phase-3, leaving a stale KV lock.

The fix: use `GET /campaigns/analytics` (batch, no campaign ID) to fetch all campaign analytics per workspace in a single call, replacing N serial MCP calls.

## What was built

1. **`instantly-direct.ts`** -- New `getBatchCampaignAnalytics(workspaceId)` method. Calls `GET /campaigns/analytics` once per workspace, returns `Map<campaignId, {leads_count, contacted, completed_count, bounced_count, unsubscribed_count}>`.

2. **`index.ts`** -- 6 changes:
   - Removed `const leadsApi = mcpApi` (MCP no longer needed for leads)
   - MCP `connect()` now conditional on `!useDirectApi` (was always-connect)
   - MCP reconnect block before Phase 3 replaced with batch fetch loop (one API call per workspace, before the candidate loop)
   - Inside candidate loop: batch Map lookup in direct mode, MCP fallback preserved in non-direct mode
   - All 3 audit entries (EXHAUSTED, WARNING, RECOVERED) updated: `active: totalLeads - completed`, `skipped: 0`
   - Slack notification calls updated to use `totalLeads - completed` instead of the old `active` variable

3. **`types.ts`** -- JSDoc added to `active` and `skipped` fields documenting the approximation when using direct API.

## Things to watch after deploy

- **`leadsChecked` in run summary** should be > 0 (was 0 when MCP failed)
- **Duration** should drop significantly -- no more MCP SSE overhead in Phase 3
- **No "MCP reconnected for leads check" log line** should appear in direct mode
- If a batch fetch fails for a workspace, all candidates in that workspace skip with a warning (graceful degradation, not crash)
- `skipped` field in leads_audit_logs will be `0` going forward -- this is expected and documented
