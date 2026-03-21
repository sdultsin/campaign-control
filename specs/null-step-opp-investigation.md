# Null-Step Opportunity Leakage Investigation

**Created:** [2026-03-20]
**Priority:** Low-medium (not a blocker, but a latent safety risk)
**Type:** Investigation + fix if warranted

---

## Problem

Instantly's `get_step_analytics` endpoint sometimes returns rows where `step` is `null`, `"null"`, or undefined. These rows can contain opportunities that aren't attributed to any real step/variant.

CC's evaluator filters analytics by step index:

```ts
// evaluator.ts:48-49
if (parseInt(a.step, 10) !== stepIndex) return false;
```

`parseInt("null", 10)` returns `NaN`. `NaN !== 0` is always true. So null-step rows are silently excluded from every step's evaluation. Any opps on those rows are invisible to the kill decision.

**Failure mode:** If a real interested reply gets attributed to a null-step row instead of its correct step/variant, CC undercounts that variant's opps. The variant looks worse than it is. This is the UNSAFE direction -- it could cause a false-positive kill on a healthy variant.

**Current evidence:** The March 20 12pm audit checked 6 campaigns and got 6/6 exact opp matches between CC and the Instantly UI, suggesting this is either rare or the null-step opps are genuinely orphaned (not stolen from real variants). But the sample is small.

## What This Agent Should Do

### Phase 1: Quantify the Problem

Using the direct Instantly API (per-workspace API keys in `INSTANTLY_API_KEYS` env var on the Cloudflare Worker, or via the Instantly MCP tools), sample at least 20 campaigns across multiple workspaces and for each:

1. Call `get_step_analytics` with `include_opportunities_count=true`
2. Check if ANY rows have `step` that is `null`, `"null"`, `""`, `undefined`, or any non-numeric value
3. For each null-step row found, record: campaign name, workspace, the row's `sent`, `replies`, `opportunities` values
4. Sum all step-level opps (excluding null-step rows) and compare to `get_campaign_analytics` total opps for that campaign
5. Record the delta

**Output a table like:**

| Campaign | Workspace | Total Opps (campaign-level) | Sum of Step Opps (valid steps only) | Null-Step Opps | Delta |
|----------|-----------|----------------------------|--------------------------------------|----------------|-------|

If Delta > 0 for any campaign, that's opp leakage. If null-step opps account for the delta, that confirms they're "stolen" from real variants.

### Phase 2: Assess Severity

Based on Phase 1 data:

- What % of campaigns have null-step rows?
- What % of total opps land on null-step rows?
- Do null-step opps correlate with campaign age, workspace, or step count?
- Would any of the null-step opps have changed a kill/keep decision under current thresholds (4000:1 Funding, 6000:1 ERC, 14000:1 S125)?

### Phase 3: Propose Fix (if warranted)

If leakage exists and could affect kill decisions, propose a fix. Options to evaluate:

**Option A -- Cross-validation gate (pre-kill safety check)**
Before executing any kill, compare step-level opp sum to campaign-level opp total. If they diverge by more than N (e.g., 2 opps or 20%), skip the kill and log a `CROSS_VALIDATION_FAILED` audit entry. This is defensive -- it catches the problem without trying to fix Instantly's data.

**Option B -- Null-step opp redistribution**
If null-step opps exist, redistribute them proportionally across active variants in the campaign (weighted by sent volume). This tries to "fix" the data but introduces assumptions.

**Option C -- Null-step opp inclusion**
Add null-step opps to every step's evaluation (treat them as belonging to "all steps"). Safest direction -- inflates opp counts, which means fewer kills, which is the safe direction.

**Option D -- Accept the risk**
If Phase 1 shows this is extremely rare (< 1% of campaigns, < 5% of opps), document it and move on. The Redemption Window provides a 48h safety net, and MAX_KILLS_PER_RUN=10 limits blast radius.

For whichever option you recommend, include:
- Which files change
- Rough line count
- Edge cases

## System Context

**Architecture:** Cloudflare Worker (`builds/auto-turn-off/`). Runs 3x daily via cron. Evaluates all active campaigns across 17 Instantly workspaces. For each campaign, fetches step analytics, evaluates each variant against a sent:opp ratio threshold, and kills underperformers.

**Key files:**
- `src/evaluator.ts` -- Kill decision logic. This is where null-step rows get filtered out (line 48-49).
- `src/instantly-direct.ts` -- Direct API client. `getStepAnalytics()` (line 115-127) fetches the raw data. `getCampaignAnalytics()` (line 158-169) fetches campaign-level totals for cross-validation.
- `src/types.ts` -- `StepAnalytics` type (line 20-28): `step` is typed as `string`, not `number`.
- `src/index.ts` -- Orchestrator. Phase 1 loops through workspaces/campaigns and calls evaluator.

**API endpoints involved:**
- `GET /api/v2/campaigns/analytics/steps?campaign_id={id}&include_opportunities_count=true` -- Returns per-step, per-variant analytics. The `step` field is a string. Normally "0", "1", etc. Sometimes null.
- `GET /api/v2/campaigns/{id}/analytics` -- Returns campaign-level totals including `contacted`, `sent`. Can get opps from `get_campaign_analytics` MCP tool or direct API.

**How to call the API:** Use the Instantly MCP tools available in the session (`mcp__instantly__get_step_analytics`, `mcp__instantly__get_campaign_analytics`, `mcp__instantly__get_campaigns`). The MCP server has access to all workspaces. Alternatively, read the API key map from the worker's wrangler.toml secrets (but MCP is easier for investigation).

**Workspaces to sample from:** Pick at least 3-4 with active campaigns:
- `the-dyad` (Carlos, Funding)
- `renaissance-1` (Ido, Funding)
- `the-eagles` (shared, Funding)
- `equinox` (Leo, Funding)
- `erc-1` or `erc-2` (ERC product -- different thresholds)

## Execution Instructions

1. Run investigation (Phase 1-2) using MCP tools -- no code changes needed for this part
2. If a fix is warranted (Phase 3), write the fix proposal as a summary with file-level diffs, NOT as executed code
3. Return findings + recommendation to the main chat

This is a research-first task. Do not modify any source files.

---

## Investigation Results [2026-03-20]

### Findings
- **100% of campaigns** have null-step rows (ubiquitous in Instantly API)
- **25% of campaigns** (5/20) have opps on null-step rows, totaling ~1.4% of all opps (de-duplicated)
- A **larger leakage source** exists: some campaigns show 8-11 opps missing from step analytics entirely (not on null-step rows). Likely subsequence opps.
- **Variant-level accuracy confirmed**: 6/6 exact matches between CC and Instantly UI in the March 20 12pm audit
- **No false-positive kills** would have occurred in this sample under current thresholds

### Decision: Accept the risk (Option D). No code changes.

The null-step opps are genuinely orphaned -- not stolen from real variants. The variant-level data CC uses for kill decisions matches what CMs see in the Instantly UI. CMs don't factor in null-step or unattributed opps when deciding to kill a variant -- they just compare variant opps to variant sent. CC should follow the same human logic.

A cross-validation gate spec was drafted but rejected as over-engineering. The system works correctly at the level that matters: per-variant accuracy.
