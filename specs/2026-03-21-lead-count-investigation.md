# Lead Count Mismatch Investigation

**Date:** 2026-03-21
**Triggered by:** 6pm validation audit — CC's lead depletion verdicts don't match Instantly UI
**Goal:** Diagnose why CC's "uncontacted" counts are wrong, propose fix(es)

---

## The Problem

CC's lead monitor reports incorrect "uncontacted" counts for many campaigns. Some campaigns are flagged as "Exhausted" (0 uncontacted) when the UI shows thousands of uncontacted leads. Others are flagged as "Running Low" with counts that don't match the UI.

---

## How CC Currently Calculates Uncontacted

**File:** `src/leads-monitor.ts` lines 10-15

```typescript
export function computeUncontacted(totalLeads: number, contacted: number): number {
  return Math.max(0, totalLeads - contacted);
}
```

**Data source:** `GET /campaigns/analytics` (batch, no campaign_id filter)
- `leads_count` → totalLeads
- `contacted_count` → contacted

**File:** `src/instantly-direct.ts` lines 228-259 (`getBatchCampaignAnalytics`)

**Verdict logic** (`src/leads-monitor.ts` lines 26-41):
- EXHAUSTED: `uncontacted <= 0`
- WARNING (Running Low): `0 < uncontacted < dailyLimit`
- HEALTHY: `uncontacted >= dailyLimit`

Code comment says: "contacted_count from the batch analytics API already includes leads that subsequently bounced, completed, or unsubscribed — so we only subtract contacted from total."

---

## Evidence: CC vs Instantly UI

### Campaigns where CC said "Exhausted" (0 uncontacted)

| Campaign | Workspace | CC Total | CC Contacted (implied) | UI Total | UI Contacted | UI Uncontacted | CC Correct? |
|----------|-----------|----------|----------------------|----------|-------------|---------------|------------|
| OFF - Pair - Cleaning copy (Alex) | Renaissance 5 | 21,909 | ≥21,909 | 26,839 in seq | 7,758 started | ~19,081 | **WRONG** |
| OLD - Funding (Ido) | Renaissance 1 | 35,430 | ≥35,430 | All leads deleted | - | 0 | **CORRECT** (but trivially — no leads) |
| OFF - Pair 4 - Property V2 (SAMUEL) NP | The Eagles | 36,271 | ≥36,271 | 36,271 total | 12,600 contacted | ~23,671 | **WRONG** |
| OFF 🗓️ Captel Capital - Beauty (CARLOS) | The Dyad | 41,013 | ≥41,013 | Not verified | - | ? | Unknown |

### Campaigns where CC said "Running Low" — WRONG counts

| Campaign | Workspace | CC Uncontacted | UI Total | UI Contacted | UI Uncontacted (calc) | Delta |
|----------|-----------|---------------|----------|-------------|----------------------|-------|
| OFF - Pair 1 - Restaurants (Alex) | Renaissance 5 | 734 | 23,200 | 14,900 | ~8,300 | -7,566 |
| OFF - Property Maint (Alex) | Renaissance 5 | 6,818 | 21,800 | 7,500 | ~14,300 | -7,482 |
| OFF - HI (Alex) | Renaissance 5 | 9,770 | 27,800 | 9,000 | ~18,800 | -9,030 |
| OFF - Beauty (Alex) | Renaissance 5 | 10,043 | 24,200 | 7,100 | ~17,100 | -7,057 |

### Campaigns where CC said "Running Low" — CORRECT counts

| Campaign | Workspace | CC Uncontacted | UI Total | UI Contacted | UI Uncontacted (calc) | Delta |
|----------|-----------|---------------|----------|-------------|----------------------|-------|
| OFF - General (Alex) | Renaissance 5 | 13,920 | 21,400 | 7,500 | ~13,900 | ~0 |
| No Show (Ido) | Renaissance 1 | 12 | 13 | 1 | 12 | 0 |
| OFF - HOME IMP (Samuel) | The Eagles | 13,810 | 16,200 | 2,400 | ~13,800 | ~0 |

---

## Pattern Analysis

**Campaigns where CC is CORRECT:** General (Alex), No Show (Ido), HOME IMP (Samuel)
**Campaigns where CC is WRONG:** All of Alex's other campaigns, Cleaning (Alex), Property V2 (Samuel), likely Captel (Carlos)

Key observation: **CC consistently undercounts uncontacted leads.** The `contacted_count` from the API appears inflated relative to what the UI shows as "contacted" or "started sequence."

For the "Exhausted" false positives, CC is computing `contacted >= totalLeads`, which means the API's `contacted_count` exceeds or equals `leads_count`. But the UI shows far fewer contacted leads.

---

## Hypotheses to Investigate

### Hypothesis 1: `contacted_count` is a lifetime accumulator
The Instantly API's `contacted_count` may be a **lifetime counter that never decreases**, even when leads are deleted from the campaign. Meanwhile, `leads_count` reflects **current** leads in the campaign.

If a CM:
1. Uploads 10K leads, campaign contacts 5K → leads_count=10K, contacted=5K
2. CM deletes the 5K contacted leads → leads_count=5K, contacted=5K (still lifetime)
3. CM uploads 10K new leads → leads_count=15K, contacted=5K
4. Campaign contacts 3K more → leads_count=15K, contacted=8K

Over multiple cycles, `contacted_count` accumulates while `leads_count` fluctuates, eventually causing `contacted >= leads_count` → false "Exhausted."

**How to test:** Compare `contacted_count` from the batch API vs `leads_count` for a campaign with known lead churn history. If `contacted > leads_count`, this confirms the theory.

### Hypothesis 2: Batch endpoint returns different data than per-campaign endpoint
The batch `GET /campaigns/analytics` (no campaign_id) may aggregate or cache differently than `GET /campaigns/analytics?campaign_id=X`.

**How to test:** For one mismatched campaign, call both the batch and per-campaign endpoints and compare the returned `leads_count` and `contacted_count`.

### Hypothesis 3: `leads_count` vs actual lead count divergence
The `leads_count` field in the analytics response may not equal the actual number of leads in the campaign (obtainable via `GET /leads?campaign_id=X&limit=0`).

**How to test:** For a mismatched campaign, compare `leads_count` from analytics vs the count from the leads endpoint.

### Hypothesis 4: The "contacted" definition differs between API and UI
The API's `contacted_count` might count any lead that received ANY email (including follow-up steps), while the UI's "contacted" or "started sequence" means "entered step 1." Or vice versa.

**How to test:** Find a campaign where step 1 has fewer sends than later steps (unlikely but possible with subsequences).

---

## Investigation Steps

### Step 1: Raw API comparison
For 2-3 mismatched campaigns (pick from both Exhausted and Running Low wrong), call:

1. **Batch analytics:** `GET /campaigns/analytics` for the workspace — extract `leads_count` and `contacted_count` for the campaign
2. **Per-campaign analytics:** `GET /campaigns/analytics?campaign_id=X` — compare fields
3. **Lead count endpoint:** `GET /leads?campaign_id=X&limit=0` — get actual lead count from pagination metadata

Use these campaign IDs:
- **OFF - Pair - Cleaning copy (Alex):** Find in Renaissance 5 via `get_campaigns` search
- **OFF - Pair 4 - Property V2 (SAMUEL) NP:** Find in The Eagles via `get_campaigns` search
- **OFF - Pair 1 - Restaurants copy (Alex) X:** Find in Renaissance 5 via `get_campaigns` search
- **OFF - General (Alex):** Find in Renaissance 5 (this one was CORRECT — use as control)

Compare all three data sources for each campaign.

### Step 2: Check for lead churn history
For the mismatched campaigns, check if leads have been deleted and re-uploaded over time. The `leads_count` vs `contacted_count` relationship will reveal if contacted is accumulating.

### Step 3: Check the `countLeads` fallback
CC has a fallback in `src/instantly-direct.ts` lines 132-159 that uses `GET /leads?campaign_id=X&limit=0` and returns status breakdowns (completed, active, skipped, bounced, unsubscribed). Compare this data source to the batch analytics endpoint.

### Step 4: Examine the Instantly API docs
Check if Instantly documents whether `contacted_count` is lifetime or current. Check if there's a better field or endpoint for getting accurate uncontacted counts.

---

## Deliverable

After investigation, produce:
1. **Root cause** — which hypothesis (or combination) explains the data
2. **Proposed fix(es)** — code-level solution(s) with tradeoffs:
   - Alternative API endpoints or fields to use
   - Whether to switch from batch analytics to per-campaign lead counting
   - Whether to use lead status breakdowns instead of the contacted/total formula
   - Performance implications (batch = 1 call/workspace vs per-campaign = N calls)
3. **Validation plan** — how to verify the fix works before deploying

Save the results to `builds/auto-turn-off/specs/2026-03-21-lead-count-diagnosis.md`.
