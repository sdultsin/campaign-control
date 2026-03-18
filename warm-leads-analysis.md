# Warm Leads Workspace: KPI Threshold Analysis

**Date:** 2026-03-15
**Source:** Live Instantly API data (MCP)
**Purpose:** Establish sent:opportunity ratio threshold for the auto-turn-off system on the Warm Leads workspace

---

## 1. Executive Summary

The Warm Leads workspace operates at a fundamentally different performance level than Funding workspaces. The aggregate sent:opportunity ratio is **135:1** -- roughly **30x better** than the Funding threshold of 4,000:1. This means the Warm Leads threshold needs to be much tighter to catch underperformers.

**Recommended threshold: 500:1**

This is aggressive enough to catch genuinely broken variants but won't kill anything currently performing (only 3 of 52 step-variants with 1,000+ sends are above 500:1, and all 3 are low-confidence edge cases with only 2-3 opportunities).

---

## 2. Workspace Overview

| Metric | Value |
|--------|-------|
| Total campaigns | 14 (10 active, 3 paused, 2 completed) |
| Total emails sent | 464,880 |
| Total opportunities | 3,442 |
| Total replied | 17,894 |
| Aggregate sent:opp ratio | **135:1** |
| Opportunity rate | **0.74%** |
| Reply rate (unique) | 2.86% |
| Bounce rate | 0.46% |

---

## 3. Campaign-Level Ratios (all campaigns with 1,000+ sends)

| Campaign | Status | Sent | Opps | Ratio | Opp Rate |
|----------|--------|-----:|-----:|------:|:--------:|
| GreenBridge Capital - Stale/Closed Lost (active) | active | 4,363 | 127 | **34:1** | 2.91% |
| Big Think Capital - Application Out | paused | 14,058 | 212 | **66:1** | 1.51% |
| Big Think Capital - Meeting Happened | paused | 8,078 | 79 | **102:1** | 0.98% |
| GreenBridge Capital - No Show | active | 30,549 | 242 | **126:1** | 0.79% |
| Big Think Capital - No Show | active | 14,897 | 116 | **128:1** | 0.78% |
| GBC - Declined | completed | 4,278 | 30 | **143:1** | 0.70% |
| GreenBridge Capital - Stale/Closed Lost (completed) | completed | 11,551 | 63 | **183:1** | 0.55% |
| Opps - Blue Haven | active | 125,215 | 633 | **198:1** | 0.51% |
| GreenBridge Capital - Application Out | active | 33,361 | 152 | **219:1** | 0.46% |
| Opps - SummitBridge | active | 114,311 | 445 | **257:1** | 0.39% |

### Campaign-Level Stats

| Stat | Value |
|------|------:|
| Min | 34:1 |
| P25 | 102:1 |
| **Median** | **136:1** |
| Mean | 146:1 |
| P75 | 198:1 |
| P90 | 257:1 |
| Max | 257:1 |

---

## 4. Step-Variant Level Analysis (1,000+ sends, n=52)

### Distribution

| Stat | Value |
|------|------:|
| Min | 46:1 |
| P10 | 70:1 |
| P25 | 119:1 |
| **Median** | **177:1** |
| Mean | 208:1 |
| P75 | 280:1 |
| P90 | 389:1 |
| Max | 526:1 |

### Performance by Campaign Type

| Type | n | Median | Mean | Range |
|------|--:|-------:|-----:|------:|
| Meeting Happened | 4 | 102:1 | 101:1 | 62-137:1 |
| Application Out | 13 | 130:1 | 156:1 | 46-375:1 |
| No Show | 13 | 148:1 | 189:1 | 67-526:1 |
| Stale/Closed Lost | 7 | 217:1 | 294:1 | 96-526:1 |
| Opps (Blue Haven + SummitBridge) | 15 | 261:1 | 259:1 | 149-413:1 |

**Key insight:** Campaign types with warmer intent (Meeting Happened, Application Out) convert better than re-engagement plays (Stale/Closed Lost, Opps). The "Opps" campaigns are the highest volume but worst-performing in the workspace -- their median of 261:1 is still 15x better than Funding's 4,000:1.

### Bottom 10 Step-Variants (worst performing with 1,000+ sends)

| Campaign | Step | Sent | Opps | Ratio |
|----------|-----:|-----:|-----:|------:|
| GB - Stale (completed) | 2 | 1,579 | 3 | 526:1 |
| GB - No Show, var 3 | 2 | 1,053 | 2 | 526:1 |
| GB - Stale (completed) | 6 | 1,021 | 2 | 510:1 |
| Opps - SummitBridge | 4/v0 | 9,914 | 24 | 413:1 |
| GB - No Show, var 2 | 0 | 1,187 | 3 | 396:1 |
| GB - Stale (completed) | 5 | 1,171 | 3 | 390:1 |
| GB - Application Out | 4 | 5,626 | 15 | 375:1 |
| Opps - SummitBridge | 4/v1 | 9,732 | 27 | 360:1 |
| Opps - SummitBridge | 1/v0 | 12,182 | 41 | 297:1 |
| Opps - Blue Haven | 3 | 23,371 | 79 | 296:1 |

Note: The three 500+ ratio variants all have only 2-3 opportunities each -- low statistical confidence. The first high-confidence underperformer is SummitBridge step 4 at 413:1 (24 opps).

---

## 5. Threshold Impact Analysis

| Threshold | Variants Killed | % of Total | Notes |
|----------:|----------------:|-----------:|-------|
| 500:1 | 3/52 | 6% | Only low-confidence edge cases (2-3 opps each) |
| 400:1 | 6/52 | 12% | Starts catching real underperformers |
| 350:1 | 8/52 | 15% | Catches SummitBridge step 4, GB Application Out step 4 |
| 300:1 | 10/52 | 19% | Catches more SummitBridge and Blue Haven late steps |
| 250:1 | 14/52 | 27% | Gets aggressive -- kills some average performers |
| 200:1 | 19/52 | 37% | Too tight -- kills above-median performers |

---

## 6. Threshold Recommendation

### Primary recommendation: **500:1**

**Reasoning:**
- The P90 of step-variant ratios is 389:1. A 500:1 threshold sits comfortably above P90, meaning it only catches clear outliers.
- At the current state, nothing with meaningful volume would be killed. The three variants above 500:1 are all edge cases with 2-3 opportunities (statistically noisy).
- This gives a natural safety margin: a variant would need to perform 3.7x worse than the workspace median (177:1) to be killed.
- It's 8x tighter than the Funding threshold of 4,000:1, proportional to the ~30x better performance of this workspace.

### Why not tighter?

A 300-400:1 threshold would start killing step 4/5 variants in the Opps campaigns (SummitBridge, Blue Haven). Late-sequence steps naturally convert worse because they're hitting leads who already didn't respond to 3-4 earlier touches. These aren't "broken" -- they're doing what follow-up steps do. Killing them prematurely would reduce total opportunity capture.

### Why not looser?

At 750:1 or 1,000:1, you'd never catch anything in this workspace. The entire distribution caps out at 526:1 currently. The threshold would be decorative, not functional.

### Consider also: minimum sends gate

The three variants above 500:1 all have very low opportunity counts (2-3). The auto-turn-off system should require a minimum number of sends (e.g., 2,000-3,000) before evaluating a variant, to avoid killing things based on noise.

---

## 7. Comparison to Funding Threshold

| Metric | Funding | Warm Leads | Ratio |
|--------|--------:|-----------:|------:|
| Current threshold | 4,000:1 | (proposed) 500:1 | 8x tighter |
| Typical campaign performance | ~2,000-3,000:1 [est.] | 135:1 | ~20x better |
| Worst acceptable performance | 4,000:1 | 500:1 | 8x tighter |

The 8x tighter threshold is appropriate given that warm leads should be roughly an order of magnitude more responsive than cold prospects in Funding workspaces. The threshold is proportional to the performance difference.

---

## 8. Data Caveats

1. **No delivery/open tracking:** Instantly does not track delivery or open rates for this workspace (all show 0%). We can only evaluate on sent:opportunity.
2. **Opportunity definition may vary:** Confirm with Ido whether "opportunity" means the same thing in Warm Leads as in Funding (e.g., is it interest-tagged, or booked meeting, or something else).
3. **Supabase pipeline broken:** This analysis uses live Instantly API data only. Supabase sync is unreliable per Outreachify audit.
4. **Two high-volume campaigns dominate:** Opps - Blue Haven (125K sent) and Opps - SummitBridge (114K sent) account for 51% of all sends. Their 200-260:1 ratios anchor the distribution upward.
5. **Small-volume campaigns excluded:** DCX - No Show (396 sent), Llama Loan variants, and Big Think App Missing (498 sent) were excluded from variant analysis due to insufficient volume.
