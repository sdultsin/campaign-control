# Send Count Inflation Investigation

**Date:** 2026-03-20
**Priority:** URGENT (6am ET run could cause premature kills)
**Codebase:** `builds/auto-turn-off/src/`

---

## Problem

CC reports higher sent counts than the Instantly UI for some variants. In the 7pm run, 8 of 26 variants had inflated send counts while opp counts were 100% accurate.

### Evidence from 7pm run (CC sent vs UI sent)

| Campaign | Step | Var | CC Sent | UI Sent | Delta |
|----------|------|-----|---------|---------|-------|
| New campaign 4 | 1 | A | 9,815 | 8,843 | +972 |
| New campaign 4 | 1 | B | 9,812 | 8,847 | +965 |
| New campaign 4 | 1 | C | 9,811 | 8,846 | +965 |
| New campaign 4 | 1 | D | 9,812 | 8,847 | +965 |
| Restaurants (RG2157-2160) | 1 | A | 21,665 | 20,915 | +750 |
| Restaurants (RG2157-2160) | 1 | D | 21,657 | 20,916 | +741 |
| Restaurants (RG2157-2160) | 3 | B | 13,237 | 10,820 | +2,417 |
| Kindred Capital (RG2623-2634) | 1 | C | 16,299 | 15,788 | +511 |
| Kindred Capital (RG2623-2634) | 5 | C | 7,222 | 5,321 | +1,901 |

Meanwhile, these campaigns had **perfect matches**: Home Improvement (RG944-951), all Carlos campaigns (The Dyad), most Alex campaigns (Ren 4/5).

### Immediate risk

Alex Construction (Ren 4) Step 1 Variants E and F: CC says 3,750 sent (98.7% of threshold), UI says 2,608 sent (only 69%). If CC fires on these at 6am, it would be a **premature kill** — the variants haven't actually hit threshold.

### Prior work

A date filter fix was specced on 2026-03-18: `specs/cc-date-filter-fix-v1-tdd.md` (project root). That TDD identified that `get_step_analytics` overcounts when called without date filters. The fix: pass `start_date` (campaign creation date) and `end_date` (today) to every call. Check if this fix was deployed to the current worker (hash `87d06fa`).

---

## Investigation Steps

### Step 1: Check if date filter fix is deployed

Read `src/instantly.ts` and `src/instantly-direct.ts`. Look for:
- Does `getStepAnalytics()` pass `start_date` and `end_date` parameters?
- Is the campaign's `timestamp_created` being used as the start date?
- Is there a fallback for campaigns without creation dates?

Also read `src/index.ts` to see how step analytics are called in the main flow.

### Step 2: Reproduce the discrepancy

Use the Instantly MCP to call `get_step_analytics` for one of the inflated campaigns:
- Campaign: `New campaign 4` in workspace `Renaissance 1`
- Call WITHOUT date filters, record the variant sent counts
- Call WITH date filters (start_date = campaign creation date, end_date = today), record again
- Compare both against the UI values from the sheet: A=8,843, B=8,847, C=8,846, D=8,847, E=8,845

### Step 3: Check why some campaigns match and others don't

Compare an inflated campaign (New campaign 4) with a matching campaign (Home Improvement). What's different?
- Different workspace settings?
- Different campaign age?
- Different number of account pairs?

### Step 4: Fix

If date filters aren't being passed:
- Implement the fix per `specs/cc-date-filter-fix-v1-tdd.md`
- Pass `start_date` and `end_date` to every `get_step_analytics` call

If date filters ARE being passed but still inflated:
- Try using `instantly-direct.ts` (REST API) instead of MCP
- Check if the date filter parameters are being formatted correctly
- Check if Instantly API has a timezone mismatch

---

## Execution Instructions

1. `/technical` to load the codebase context
2. Read the files listed in Step 1
3. Run investigation Steps 1-3
4. If fix needed, implement and run `tsc --noEmit`
5. `/cc-review` loop until approved
6. Deploy and verify with a test run
7. Write handoff doc

---

## Success Criteria

- [ ] Root cause identified for the send count inflation
- [ ] All 11 campaigns from the 7pm run return sent counts matching the Instantly UI (within 1% tolerance)
- [ ] Alex Construction E/F no longer at risk of premature kill
- [ ] `tsc --noEmit` passes
