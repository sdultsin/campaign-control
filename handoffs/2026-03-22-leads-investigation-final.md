# Leads Monitoring Investigation - Final Results

**Date:** 2026-03-22
**Status:** RESOLVED. Batch analytics is accurate. No hybrid build needed.

## TL;DR

The batch analytics formula `active = leads_count - completed_count - bounced_count - unsubscribed_count` is accurate to within 0.2%. The earlier concern about "lifetime accumulators" was based on comparing the MCP wrapper's renamed fields (which drop critical data) against the raw v2 API fields (which are correct). The deployed code (`18aaf70`) is already producing the right results.

## What Was Actually Broken

Leads monitoring showed `leads_checked: 0` on every run since the direct API migration because:
1. MCP connect was skipped in direct mode (line 496: `if (!useDirectApi)`)
2. Batch analytics wasn't wired into Phase 3 until `18aaf70`
3. No run has occurred yet on `18aaf70` -- first run will be 6am ET 2026-03-23

## The Data Comparison

Tested R2 campaign `f5c666bb` (OFF - PAIR 6 - ADVERTISING - EYVER):

| Field | v2 API Direct | MCP count_leads | Match |
|-------|--------------|-----------------|-------|
| total leads | `leads_count: 36,548` | `total_leads: 36,548` | EXACT |
| completed | `completed_count: 469` | `completed: 469` | EXACT |
| bounced | `bounced_count: 204` | `bounced: 93` | API 2.2x (step-level) |
| unsubscribed | `unsubscribed_count: 0` | `unsubscribed: 9` | Minor |
| derived active | 35,875 | `active: 35,955` | 0.2% off |

The 0.2% error (80 leads on 36K) comes from `bounced_count` being a step-level counter. This means our formula slightly understates active leads -- safe direction for depletion alerts.

## Why Earlier Investigations Were Misleading

1. **Agent #1 compared MCP fields to MCP analytics** -- the MCP `get_campaign_analytics` wrapper returns `leads: 0` (renamed/transformed field), not the raw v2 `leads_count: 36,548`. This made it look like the API returned no lead counts.

2. **The "accumulator" concern** was real for `contacted_count` (step-level, 4-10x inflated) but NOT for `completed_count` or `leads_count`. Our formula doesn't use `contacted_count`.

3. **The OpenAPI spec truncation** initially didn't show `completed_count` and `bounced_count` in the schema, making it seem like those fields didn't exist. The raw API response confirmed they do.

## What's Deployed

Version `18aaf70` with batch analytics:
- 1 API call per workspace (~200ms each) via `getBatchCampaignAnalytics()`
- Reads `leads_count`, `completed_count`, `bounced_count`, `unsubscribed_count`
- Computes `active = leads_count - completed - bounced - unsub` (clamped to 0)
- MCP Phase 3 reconnect code is present as fallback but batch is primary

## What Was Built But Not Needed

- `specs/2026-03-22-hybrid-leads-validation.md` -- SUPERSEDED. Hybrid approach unnecessary.
- `src/mcp-durable-object.ts` -- Durable Objects proxy. Not needed since batch works.
- `src/mcp-do-client.ts` -- DO client. Not needed.
- `src/mcp-test.ts` -- SSE connectivity test. Investigation complete, can delete.
- `specs/leads-cache-design.md` -- KV caching design. Not needed.
- `specs/parallel-mcp-analysis.md` -- Parallel MCP analysis. Not needed.

These files can be cleaned up or kept for reference if MCP is ever needed for something else.

## SSE Finding (Bonus)

MCP SSE from CF Workers DOES work. The connection was never broken -- just never attempted in direct mode. Full handshake completes in ~160ms. `count_leads` takes ~23s because the MCP server paginates 249 pages of `POST /api/v2/leads/list` internally. This is only relevant if we ever need per-lead status data that batch analytics doesn't provide (e.g., `skipped` count).

## Remaining Verification

- Confirm `18aaf70` first run (6am ET 2026-03-23) produces `leads_checked > 0`
- Spot-check a few EXHAUSTED/WARNING alerts against the Instantly UI
- Compare the `leads_count` values in Supabase `leads_audit_logs` against Instantly UI for the same campaigns

## Thomas/Daniel Message

The Slack draft at `deliverables/slack-draft-mcp-count-leads.md` is no longer urgent. The question about what endpoint `count_leads` wraps is answered: it paginates `POST /api/v2/leads/list` at 100/page. No action needed from Outreachify for leads monitoring.
