# Bug: Opportunity Misattribution Causes False Positive (Unsafe Direction)

> **[2026-03-18 UPDATE] This bug is partially invalidated.** The opportunity undercount (2 vs 6) was caused by using date-filtered `get_step_analytics` calls. Unfiltered calls return the correct opportunity count. The sent count discrepancy (API 14,135 vs UI 6) was also likely a UI date-filter issue. The core finding that date filters break opp counts remains valid — but the conclusion that the API is fundamentally unreliable is wrong. Unfiltered `get_step_analytics` matches the UI.

**Date:** 2026-03-18
**Campaign:** RG55/RG56/RG57/RG58 - Summit Bridge - General (CARLOS) (copy)
**Workspace:** The Dyad
**CM:** Carlos
**Severity:** Critical (invalidates a safety assumption)

## What Happened

Campaign Control's 4:01 PM scan flagged Variant A in Step 1 as a "cannot disable" blocked variant, claiming it exceeded the 3,800:1 kill threshold. Manual verification against the Instantly UI shows the variant is actually healthy and should NOT have been flagged.

## The Data Discrepancy

| Source | Emails Sent | Opportunities | Ratio | vs Threshold (3,800:1) |
|--------|------------|---------------|-------|----------------------|
| **Campaign Control (API)** | 14,135 | **2** | 7,067.5:1 | ABOVE (flagged) |
| **Instantly UI** | 14,135 | **6** | 2,355.8:1 | BELOW (healthy) |

- Sent count matches perfectly: 14,135 in both
- Opportunity count is wrong: API returned 2, UI shows 6
- The API is **undercounting** opportunities by 4

## Instantly UI (verified)

Step 1 totals: 15,878 sent / 195 replied (1.23%) / 6 opportunities

| Variant | Status | Sent | Replied | Opportunities |
|---------|--------|------|---------|---------------|
| A | Active (toggled on) | 14,135 | 171 (1.21%) | 6 |
| B | Disabled (toggled off) | 1,743 | 24 (1.38%) | 0 |

Variant A is the last active variant in Step 1 (Variant B is disabled).

## Slack Notification (what Campaign Control posted)

> :warning: Cannot disable Variant A in Step 1 (last active)
>
> Workspace: The Dyad
> Campaign: RG55/RG56/RG57/RG58 - Summit Bridge - General (CARLOS) (copy)
> Step 1, Variant A
>
> This variant exceeded the kill threshold:
> Emails sent: 14135
> Opportunities: 2
> Ratio: 14135:2 = 7067.5 (threshold: 3,800:1)
>
> But it's the LAST active variant in Step 1. The system did NOT disable it.
>
> Action needed: Add 1+ new variants to this step, then manually turn off Variant A.

## Why This Matters

The earlier assumption (documented in `specs/cc-date-filter-fix-v1-tdd.md`) was:

> "All known opp errors are in the safe direction (API overcounts opps, making variants look better than they are). No variant will be wrongly killed due to opp misattribution."

This case proves the opposite. The API **undercounted** opportunities, making the variant look worse than it is. If kills were enabled, the system would attempt to kill a healthy variant. This is the **unsafe direction**.

## Root Cause

The Instantly `get_step_analytics` API (with `include_opportunities: true`) returns incorrect opportunity counts for some variants. The date filter fix (`start_date`/`end_date` params) does not affect opportunity attribution -- this is a separate Instantly platform bug.

The sent count is accurate (14,135 matches in both API and UI). Only the opportunity attribution is wrong.

## What Needs to Happen

1. **Kills must stay paused** until this is resolved
2. **Escalate to Instantly CTO** with this specific evidence (sent matches, opps don't)
3. Consider adding **opp cross-validation** before any kill decision -- compare `get_step_analytics` opp count against `get_campaign_analytics` totals

## Related Files

- Pilot log: `builds/auto-turn-off/pilot-log-2026-03-18.md` (Evening Findings section)
- TDD spec: `specs/cc-date-filter-fix-v1-tdd.md` (Section 5, risk assessment corrected)
- Troubleshooting: `.claude/memory/troubleshooting.md` (new entry added)
- Worker code: `builds/auto-turn-off/src/instantly.ts:22-37` (getStepAnalytics call)
