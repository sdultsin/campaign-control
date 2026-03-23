# Handoff: Remove Date Filter from Main Evaluation Path

**Date:** 2026-03-21
**Version:** `ff07af8`
**Spec:** `specs/2026-03-21-remove-date-filter.md`

## What changed

Removed `startDate`/`endDate` parameters from the main evaluation `getStepAnalytics()` call in `index.ts` (line 512). The Instantly API's date-filtered response drops opportunities it can't attribute within the date window, while sent counts survive the filter -- causing undercounted opps and false kills.

## Why

The 8am ET run on 2026-03-21 produced 5 incorrect kills (out of 11 total). All 5 had undercounted opportunities due to the date filter. The 6 correct kills all had 0 UI opps, confirming the date filter as the sole cause.

This was a known bug from 2026-03-18 (`bugs/2026-03-18-summit-bridge-false-positive.md`). The date filter was re-introduced on 2026-03-20 to address sent count inflation, but the sanity check at lines 628-640 (step 1 sent vs contacted, 10% tolerance) already handles that problem.

## Files changed

- `src/index.ts` — Removed 3 lines (createdDate/startDate/endDate computation), changed comment, removed date args from `getStepAnalytics()` call

## Files NOT changed

- `src/instantly.ts`, `src/instantly-direct.ts` — Optional startDate/endDate params retained for future use
- All other source files unchanged

## Verification

- TypeScript: PASS (clean compile)
- CC Review: APPROVED
- All 4 `getStepAnalytics()` call sites now consistently unfiltered (lines 186, 512, 1177, 1244)
- Next cron run (6pm ET / 22:00 UTC) will validate opp counts match Instantly UI

## Affected campaigns to watch

- RG2161 Construction Steps 3/4/5
- Restaurants RG2157-2160 Step 1
- Summit Bridge Construction Step 3
