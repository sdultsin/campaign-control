# Subsequence Evaluation: v3 Scoping Research

**Created:** [2026-03-15]
**Status:** Research complete, multiple blockers identified
**Context:** Auto turn-off v1 evaluates primary sequence variants only. v3 extends evaluation to subsequences.

---

## Executive Summary

Subsequence evaluation for auto-turn-off is technically feasible but blocked by two independent issues:

1. **MCP `list_subsequences` bug** -- the tool doesn't expose the required `parent_campaign` parameter (confirmed: Instantly API requires it). This blocks discovery of which campaigns have subsequences.
2. **Instantly PATCH API limitation** -- the `/api/v2/subsequences/{id}` PATCH endpoint only accepts `name` updates. You cannot update `sequences`, `steps`, or `variants` (including `v_disabled`) through this endpoint.

Blocker #2 is the harder problem. Even if the MCP bug is fixed, there is no documented REST API path to disable a variant within a subsequence. This needs Instantly platform-level investigation.

---

## What Works

### Subsequence step analytics are already visible

The `GET /api/v2/campaigns/analytics/steps` endpoint returns analytics for ALL steps -- primary AND subsequence -- in a single response. Subsequence steps appear with indices beyond the primary step count.

**Confirmed with live data:**

| Campaign | Workspace | Primary Steps | Analytics Steps Found | Subsequence Steps |
|----------|-----------|--------------|----------------------|-------------------|
| ON 913-916 - Alex - Property management (Rivet Capital) | Renaissance 4 | 4 (indices 0-3) | 0-6 | 4, 5, 6 (1-3 sends each) |
| ON 898-903 - Alex - Retail (Bentora Capital) | Renaissance 4 | 4 (indices 0-3) | 0-4 | 4 (1 send) |

The v1 system already filters these out using `primaryStepCount` from campaign details. To evaluate them in v3, we'd do the opposite: extract steps where `parseInt(step) >= primaryStepCount`.

### Subsequence structure mirrors campaigns

From the Instantly API docs, a subsequence object has:
- `id` (UUID)
- `parent_campaign` (UUID)
- `name` (string)
- `status` (enum: -99, -1, -2, 0, 1, 2, 3, 4)
- `conditions` (trigger rules -- see below)
- `subsequence_schedule` (timing config)
- `sequences` (array -- identical structure to campaign sequences: steps with variants)
- `workspace` (UUID)

The `sequences` array contains steps and variants with the same schema as campaigns, including `v_disabled` on variants.

### Subsequence trigger conditions

Subsequences are triggered by one of three condition types:
- **`crm_status`**: Lead status changes (e.g., Interested, Meeting Booked, Won, Not Interested)
- **`lead_activity`**: Email Opened (2), Link Clicked (4), Campaign Completed Without Reply (91)
- **`reply_contains`**: Keyword matching on reply text

This is important for threshold decisions -- different triggers imply different lead warmth levels.

### Available MCP tools (when working)

| Tool | What It Does | Status |
|------|-------------|--------|
| `list_subsequences` | List subsequences for a parent campaign | **BROKEN** -- missing `parent_campaign` param |
| `get_subsequence` | Get full subsequence details by ID | Works (needs subsequence ID) |
| `create_subsequence` | Create new subsequence | Works |
| `update_subsequence` | Update subsequence | Works but **only updates `name`** |
| `delete_subsequence` | Delete subsequence | Works |
| `pause_subsequence` | Pause sending | Works |
| `resume_subsequence` | Resume sending | Works |
| `get_subsequence_sending_status` | Check why not sending | Works |

---

## What's Blocked

### Blocker 1: Cannot discover subsequences (MCP bug)

**Problem:** `list_subsequences` requires `parent_campaign` as a query parameter (confirmed by Instantly API docs: `GET /api/v2/subsequences?parent_campaign={uuid}`). The MCP tool schema exposes `workspace_id` and `limit` but NOT `parent_campaign`. Calling it returns:

```json
{"error": "querystring must have required property 'parent_campaign'"}
```

**Impact:** Cannot enumerate which campaigns have subsequences, or retrieve subsequence IDs.

**Fix:** Outreachify needs to add `parent_campaign` as a parameter to the MCP tool. This is a straightforward schema fix -- the underlying API endpoint already supports it.

**Workaround (direct API):** When using direct REST API calls (as v1 production does), just pass `parent_campaign` as a query param. The MCP bug only affects MCP-based research, not the production Cloudflare Worker.

### Blocker 2: Cannot disable subsequence variants via API (Instantly limitation)

**Problem:** The Instantly API `PATCH /api/v2/subsequences/{id}` endpoint is severely limited:

```
Request body schema:
{
  "name": "string"  // ONLY field accepted
}
additionalProperties: false
minProperties: 1
```

You cannot send `sequences`, `steps`, or `variants` in the PATCH body. The `additionalProperties: false` constraint means the API will reject any field other than `name`.

**This means there is no documented API path to set `v_disabled: true` on a subsequence variant.**

Compare to campaigns: `PATCH /api/v2/campaigns/{id}` accepts a full `sequences` array replacement, which is how v1 disables variants. Subsequences don't have this capability.

**Impact:** Even if we can discover and evaluate subsequence variants, we cannot act on them (disable underperformers). The system would be evaluation-only with Slack notifications, not auto-turn-off.

**Possible workarounds to investigate:**
1. **Undocumented fields** -- The PATCH might accept `sequences` despite the docs saying otherwise. Needs testing on a non-production subsequence.
2. **Delete and recreate** -- Delete the subsequence and recreate it with the variant disabled. Destructive and risky (loses lead state, resets analytics).
3. **Instantly CTO escalation** -- Renaissance has a direct CTO contact at Instantly. Request that PATCH be extended to accept `sequences` (same as campaign PATCH). This is the correct long-term fix.

### Blocker 3: No subsequence-specific analytics endpoint

The step analytics endpoint (`GET /api/v2/campaigns/analytics/steps`) returns a flat list with no field distinguishing primary steps from subsequence steps. The only way to separate them is:

1. Get primary step count from campaign details (`sequences[0].steps.length`)
2. Any analytics step index >= primary step count is a subsequence step

But this approach has a problem: **we can't map analytics step indices back to specific subsequences.** If a campaign has 3 subsequences with 2 steps each, analytics steps 4-9 are subsequence steps, but we don't know which step belongs to which subsequence without getting the subsequence details and counting their steps.

**Additional anomaly observed:** One campaign (Ellen - No Show - GBC NP, Equinox) returned a step with `"step": "\\N"` (escaped null) -- a database-level null leaking through. This needs handling as an edge case.

---

## Data Model: How Subsequence Analytics Bleed

```
Parent Campaign: 4 primary steps (step 0, 1, 2, 3)
Subsequence A: 2 steps -> appears as step 4, 5 in analytics
Subsequence B: 1 step  -> appears as step 6 in analytics

Analytics Response (flat array):
  step 0, variant 0: 4920 sent  -- PRIMARY
  step 0, variant 1: 4911 sent  -- PRIMARY
  step 1, variant 0: 3682 sent  -- PRIMARY
  ...
  step 4, variant 0: 3 sent     -- SUBSEQUENCE A, step 0
  step 5, variant 0: 2 sent     -- SUBSEQUENCE A, step 1
  step 6, variant 0: 2 sent     -- SUBSEQUENCE B, step 0
```

The v1 filter (`parseInt(step) < primaryStepCount`) correctly excludes these. The low send counts (1-3) mean subsequence variants would also be caught by the 4,000 gate in most cases.

---

## Threshold Considerations

Subsequences target leads who have already interacted with the primary sequence. Different trigger conditions imply different warmth levels:

| Trigger Type | Lead Warmth | Suggested Threshold Direction |
|-------------|------------|------------------------------|
| `crm_status: Interested` | Warm | Lower threshold (tighter) -- these should convert better |
| `crm_status: Meeting Booked` | Hot | Much lower threshold |
| `lead_activity: Campaign Completed Without Reply` | Cold (exhausted) | Higher threshold (looser) -- re-engagement is harder |
| `lead_activity: Email Opened` | Lukewarm | Slightly lower than primary |
| `reply_contains: [keyword]` | Varies | Depends on keyword intent |

**Key insight:** There is no single "subsequence threshold." The threshold should be based on the trigger condition type. This requires:
1. Fetching subsequence details to know its trigger conditions
2. A threshold lookup table by trigger type
3. Discovery calls with CMs to understand what thresholds make sense for each trigger type

**For v3 MVP:** Start with a single subsequence threshold (e.g., 2,500:1 for warm triggers, 5,000:1 for cold/re-engagement). Refine with data.

---

## Recommended Approach

### Phase 1: Fix the MCP bug + test PATCH (pre-requisites)

1. **Report MCP bug to Outreachify** -- `list_subsequences` needs `parent_campaign` parameter exposed. Straightforward fix.
2. **Test undocumented PATCH** -- On a non-production subsequence, try sending `sequences` in the PATCH body despite docs saying only `name` is accepted. If it works, the blocker is documentation-only.
3. **If PATCH doesn't work: Escalate to Instantly CTO** -- Request that `PATCH /api/v2/subsequences/{id}` accept `sequences` array, same as campaigns. This is a feature request, not a bug.

### Phase 2: Evaluate-only mode (no auto-disable)

If variant disabling remains blocked, ship subsequence evaluation as notification-only:

1. For each campaign, detect subsequence steps (analytics step >= primaryStepCount)
2. Apply threshold evaluation to subsequence variants
3. Slack the CM: "Subsequence variant X in campaign Y exceeded threshold. Manual action needed."
4. This provides visibility even without auto-turn-off capability

### Phase 3: Full auto-disable (requires PATCH fix or workaround)

Once variant disabling works:

1. For each campaign, list its subsequences via direct API (`GET /api/v2/subsequences?parent_campaign={id}`)
2. Map analytics step indices to subsequences by counting steps
3. For each subsequence variant exceeding threshold, PATCH to disable
4. Apply per-trigger-type thresholds
5. Same safety checks as primary (never kill last variant, warn on down-to-one)

### Production architecture (direct API, not MCP)

The v1 production system uses direct Instantly REST API calls, not MCP. This means:
- Blocker #1 (MCP bug) does not affect production -- direct API supports `parent_campaign`
- Blocker #2 (PATCH limitation) affects production -- this is an Instantly API limitation, not MCP
- The subsequence discovery loop adds API calls: 1 extra call per campaign (list subsequences)

**Estimated additional API calls per run:**
- List subsequences per campaign: ~238 calls (one per active campaign)
- Get subsequence details (for campaigns that have them): ~10-30 calls (estimate)
- Total increase: ~250-270 calls -> total from ~300 to ~570 calls per run
- Still well under Cloudflare Workers' 1,000 subrequest limit

---

## Open Questions

| # | Question | Ask Who | Blocks |
|---|----------|---------|--------|
| 1 | Does PATCH `/api/v2/subsequences/{id}` accept `sequences` despite docs? | Test on non-prod | Full auto-disable |
| 2 | If not, can Instantly add `sequences` to PATCH? | Instantly CTO (via Ido) | Full auto-disable |
| 3 | How many campaigns actually have subsequences? | Scan via direct API | Sizing the feature |
| 4 | What trigger conditions are used in practice? | CMs (Leo, Alex, Brendan) | Threshold design |
| 5 | Do CMs create subsequences themselves, or does someone else? | Samuel/CMs | Understanding who manages them |
| 6 | What kill thresholds make sense for warm-lead subsequences? | Ido + data analysis | Threshold config |
| 7 | Outreachify MCP fix timeline for `list_subsequences`? | Darcy | MCP research capability |

---

## Summary of Blockers and Priority

| Blocker | Severity | Owner | Resolution Path |
|---------|----------|-------|----------------|
| MCP `list_subsequences` missing `parent_campaign` | Medium (MCP only, not production) | Outreachify/Darcy | Schema fix -- add parameter |
| PATCH subsequence can't update variants | **Critical** (blocks auto-disable) | Instantly platform | Test undocumented, then escalate to Instantly CTO |
| No subsequence-specific analytics endpoint | Low (workaround exists) | n/a | Use primary step count filter + subsequence step counting |
| No per-trigger-type thresholds defined | Medium (blocks smart evaluation) | Ido + Sam | CM discovery calls + data analysis |

**Bottom line:** Subsequence evaluation can ship as notification-only (Phase 2) without any external dependency resolution. Full auto-disable (Phase 3) is blocked on Instantly's PATCH endpoint supporting variant updates. This should be escalated to the Instantly CTO contact.
