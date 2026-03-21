# V2 Data Accuracy Investigation - INVALIDATED

**Date:** 2026-03-18
**Status:** Invalidated — root cause was UI date filter, not API bug

The original investigation concluded the Instantly API returned inflated per-variant numbers. This was incorrect. The discrepancy was caused by reading the Instantly UI with a date-range filter (last 4 weeks) instead of the full lifetime view (last 12 months). When compared using the same time window, API and UI match within 0.26% on sent counts and perfectly on opportunity counts (verified across 5 campaigns, 56 variants).

See: v2-data-accuracy-resolution.md for the full comparison data.
