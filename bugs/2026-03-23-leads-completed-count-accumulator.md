# Leads completed_count Lifetime Accumulator - Campaign 7

**Date:** 2026-03-23
**Severity:** Low (safe-direction error, non-critical feature)
**Affects:** LEADS_WARNING / LEADS_EXHAUSTED only. Kill/block decisions unaffected.

## Problem

The batch analytics `completed_count` field is a lifetime accumulator for some campaigns, just like `contacted_count` was (fixed 2026-03-21). Campaign 7 (ON - PAIR 3 - General, Alex, Renaissance 5) shows `completed_count = 7,146` from batch analytics vs `completed = 116` from the `count_leads` endpoint. 60x discrepancy.

Other campaigns (5, 6, 8) matched exactly. Pattern suggests this is triggered by lead cycling (CMs deleting contacted leads and re-uploading fresh batches).

## Impact

CC computes `active = leads_count - completed - bounced - unsub`. Inflated `completed_count` makes CC underestimate remaining leads by ~7,000 (28%). This triggers LEADS_WARNING earlier than necessary - conservative (safe) direction but inaccurate.

## History of This Issue

This is the third iteration of the same fundamental problem:

| Date | Field | Problem | Fix |
|------|-------|---------|-----|
| 2026-03-21 | `contacted_count` | Lifetime accumulator, false EXHAUSTED | Switched to MCP `count_leads` (`1802bf2`) |
| 2026-03-22 | All batch fields | MCP too slow (23s/campaign) | Switched back to batch analytics (`18aaf70`) |
| 2026-03-22 | `completed_count` | Tested 1 campaign, declared "0.2% accurate" | Hybrid spec built then reverted |
| 2026-03-23 | `completed_count` | Broader verification reveals 60x off for Campaign 7 | **THIS BUG** |

## Root Cause

Instantly's batch `GET /campaigns/analytics` returns lifetime accumulators for `completed_count` (and `contacted_count`). When CMs delete completed leads and re-upload, `completed_count` keeps accumulating while `leads_count` reflects current state. The March 22 "all clear" tested one campaign (`f5c666bb`) that happened to not have lead cycling.

## Options Already Explored

1. **MCP `count_leads`** - Accurate but paginates 249 pages (23s/campaign). SSE from CF Workers works but adds latency.
2. **Batch analytics formula** - Fast (1 call/workspace) but `completed_count` can be stale.
3. **Hybrid (batch + MCP verification)** - Built and reverted 2026-03-22. Added 1-2 min latency for marginal accuracy gain on one test campaign. May be worth revisiting now that we have proof of broader inaccuracy.

## Recommendation

Document as known edge case for now. The error fails safely (early warnings, never missed depletions). Revisit if it becomes noisy or if Instantly adds a `/leads/count` endpoint. The real fix is a fast, accurate lead count API from Instantly - worth raising with CTO contact.

## Verification Source

Full verification at `specs/2026-03-23-6am-verification-results.md`, Section 2 (Campaign 7).

## Resolution

**Decision: CLOSED - Not a real problem (2026-03-24)**

Original analysis assumed CMs delete completed leads and re-upload fresh batches. Actual CM behavior is different: CMs only delete **unopened** leads for recycling. Completed leads stay in the campaign until it's truly finished. When a campaign is finished, CMs delete all leads but keep the campaign OFF (preserving analytics). CC skips OFF campaigns.

This means:
- `completed_count` in batch analytics should match actual completed leads, because completed leads are never deleted mid-campaign
- The accumulator only diverges when completed leads are deleted, which doesn't happen during active campaigns
- The `active = leads_count - completed - bounced - unsub` math is accurate under real CM workflows

**Campaign 7's 60x discrepancy** remains unexplained. Possible causes: non-standard CM behavior on that specific campaign, or an Instantly API bug. Worth spot-checking on a future run, but not worth building workarounds or escalating to Instantly CTO.

No code change. No CTO escalation. Draft message below kept for reference only.

## Draft CTO Message (NOT SENDING - kept for reference)

Hey [name] — running into a data accuracy issue with the batch analytics endpoint that I think warrants a quick API addition. `GET /campaigns/analytics` returns `completed_count` (and previously `contacted_count`) as lifetime accumulators rather than point-in-time counts — meaning when CMs delete completed leads and re-upload fresh batches, `completed_count` keeps growing while `leads_count` reflects the current state. We use these fields to monitor lead depletion in real-time, so accumulator values produce false LEADS_WARNING alerts (Campaign 7 shows 7,146 from batch vs 116 actual — 60x off). We already hit this with `contacted_count` and worked around it by switching to the MCP `count_leads` call, but that paginates through 249 pages per campaign and takes ~23 seconds each, which doesn't scale. What we actually need is either: (a) a `/leads/count` endpoint that returns current lead status counts by campaign, or (b) non-accumulator (point-in-time) status counts in the batch analytics response. Either would unblock us cleanly.
