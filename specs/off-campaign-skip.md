# Spec: Skip OFF Campaigns in Evaluation Loop

**Date:** 2026-03-25
**Status:** Ready for build

## Problem

OFF campaigns (name starts with "OFF") are currently evaluated with a 1.2x threshold buffer. This wastes API calls and processing time on campaigns CMs have intentionally turned off. These campaigns will never produce meaningful kill/warning/winner signals.

## Current Behavior

1. OFF campaigns are fetched via `getCampaigns()` and enter the evaluation loop
2. `resolveThreshold()` applies a 1.2x OFF buffer, making kills harder but still possible
3. Full evaluation runs: `getCampaignDetails()` + `getStepAnalytics()` API calls, kill/block/winner checks, leads monitoring, snapshot collection
4. Console log says `(X OFF, buffered)`

## Proposed Behavior

1. OFF campaigns are still fetched (needed for count logging)
2. Early return before any API calls or evaluation
3. No kills, no warnings, no blocks, no leads monitoring, no ghost detection for OFF campaigns
4. Console log says `(X OFF, skipped)`

## Why This Is Safe

- CMs mark campaigns OFF intentionally when they're done or pausing
- OFF campaigns have no active sending, so variant performance data is stale
- Killing a variant on an OFF campaign has zero operational impact
- Leads monitoring on OFF campaigns is noise (CMs often delete leads when turning off)
- Ghost detection on OFF campaigns is irrelevant (no active kills to ghost)
- Snapshots for OFF campaigns add bulk without actionable data

## Implementation

**File:** `src/index.ts`

**Change 1:** In the campaign processing loop (~line 631), add early return after pilot filter:

```typescript
// Pilot filter: skip campaigns whose CM is not in the pilot
if (!isPilotCampaign(cmName)) return result;

// Skip OFF campaigns — already turned off, no need to evaluate or notify
if (isOffCampaign(campaign.name)) return result;
```

**Change 2:** Update console log (~line 604):

```typescript
(offCount > 0 ? ` (${offCount} OFF, skipped)` : '') +
```

That's it. Two lines of logic, one log message update.

## Execution Instructions

1. Apply the two changes above
2. `npx tsc --noEmit` — must pass
3. Run `/cc-review` — must APPROVE
4. Commit, deploy via `./deploy.sh`
5. Verify: check next run's console logs show "OFF, skipped" and run_summary shows fewer evaluated campaigns
