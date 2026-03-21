# V2 Data Accuracy — Resolution

**Date:** 2026-03-18
**Status:** Resolved — API is accurate, ready for kills

---

## Summary

The Instantly `get_step_analytics` API (unfiltered, no date params) returns per-variant sent and opportunity counts that match the Instantly UI within negligible margins. Verified across 5 campaigns, 56 variants.

## What Went Wrong

1. V1 used date-filtered `get_step_analytics` calls (passing `start_date` and `end_date`). These return inaccurate data — overcounted sent, undercounted opps.
2. When spot-checking V2 against the UI, the UI was read with a date-range filter (last 4 weeks / last 7 days) instead of the full lifetime view (last 12 months). This made it appear the API was wrong when it was actually the UI reading that was wrong.
3. A 4-agent investigation was launched based on these incorrect readings, concluding the API was fundamentally broken. That conclusion was invalidated.

## The Actual Fix

**Use unfiltered `get_step_analytics` (no date params).** This returns data that matches the UI's full-lifetime view.

- Date-filtered calls break both sent and opp accuracy — do not use them.
- The `getAccurateStepAnalytics` dual-call approach (filtered for sent, unfiltered for opps) is unnecessary. A single unfiltered call is sufficient and accurate.

## Verification Data

5 campaigns compared (UI data copy-pasted to Google Sheet vs API):

| Campaign | Variants Checked | Max Sent Diff | Opps Match? |
|----------|-----------------|---------------|-------------|
| Construction - Google + Others | 22 | +25 (0.05%) | All match |
| Pair 2 - Clothing - Summit bridge | 12 | +28 (0.1%) | All match |
| Pair 6 - BrightFunds - Real Estate | 11 | +79 (0.26%) | All match |
| BrightFunds - Beauty Salons | 1 | +2 (0.02%) | Match |
| Roofing - Alex | 16 | +3 (0.01%) | All match |
| **Total** | **56 variants** | **+79 max** | **100% match** |

## Lessons Learned

1. Always compare API data to the UI using the same time window (full lifetime / last 12 months)
2. The Instantly UI defaults to shorter date ranges in some views — this silently filters the data
3. Date-filtered API calls are unreliable for both sent and opp counts — avoid them entirely
4. Cross-validation between API endpoints proved they're internally consistent, but that wasn't the issue — the comparison target (UI reading) was wrong

## Impact on Worker

The worker should be simplified to use a single unfiltered `getStepAnalytics` call instead of the dual-call `getAccurateStepAnalytics`. The date filter code can be removed entirely.
