# Scale Winners - Design Discussion Handoff

**Date:** 2026-03-23
**Purpose:** Continue the /product design discussion in a new chat. Sam has responses to the proposals below.

**Context files to load:**
- `builds/auto-turn-off/specs/2026-03-23-scale-winners-spec.md` -- original spec (needs revision based on decisions below)
- `builds/auto-turn-off/src/evaluator.ts` -- current kill logic
- `builds/auto-turn-off/src/config.ts` -- thresholds, workspace configs
- `builds/auto-turn-off/src/slack.ts` -- notification formatting
- `builds/auto-turn-off/src/dashboard-state.ts` -- dashboard item types
- `builds/auto-turn-off/src/types.ts` -- all type definitions
- `knowledge/kpi-framework.md` -- KPI benchmarks

---

## Design Proposals Awaiting Sam's Response

### 1. Winner KPI Threshold

Sam's instinct: 2500:1 ratio. Product proposal:

Scale proportionally for other infra:

| Infra | Kill Threshold | Winner Threshold (0.66x) |
|-------|---------------|-------------------------|
| Google | 3,800 | 2,500 |
| SMTP/OTD | 4,500 | 3,000 |
| Outlook | 5,000 | 3,300 |

Guardrails:
- **Min opps: 2** -- eliminates single-opp flukes. One opp could be a mislabel, a friend, anything. Two is the bare minimum for "this is probably real."
- **Min sends: kill_threshold * 0.5** -- variant has been in market long enough (1,900 for Google). Prevents flagging something after one day of sends.

Drop the two-tier system from original spec. One threshold, one label: WINNING. Simpler for CMs, simpler to build, simpler to reason about. If you want tiers later (STRONG vs WINNER), it's a config change.

**OFF campaigns**: Apply the same 1.2x buffer. Winner threshold becomes 3,000:1 for Google OFF campaigns (2,500 * 1.2). Otherwise we'd systematically under-flag winners on weekend test campaigns -- which is exactly where CMs experiment with new angles and most want to know what's working.

### 2. Speaking Too Soon -- Minimal Rescission

The asymmetry here matters. When we kill a variant, we took an irreversible action (disabled it). That's why Redemption Window exists -- to undo damage. When we flag a winner, we took no action. The CM still decides what to do.

**Minimal solution: silent dashboard resolution + one-line Slack.**

1. **Dashboard**: WINNING items get re-evaluated every scan (4x daily). If the ratio degrades past 2500:1 or opps drop below 2 (unlikely but possible with opp reclassification), the item auto-resolves via existing `resolveStaleItems()`. Green row just disappears. No new code for this -- it's how the dashboard already works for BLOCKED items that clear.

2. **Slack**: When a previously-notified winner degrades, post a single line to the thread (not a new parent message):

```
:chart_with_downwards_trend: Update: Variant B no longer meets winner criteria (ratio now 3,200:1). No action needed.
```

This requires one new piece: a KV lookup to find the original notification's `thread_ts` so we can reply to it. That's ~10 lines. If the thread_ts isn't found (KV expired, etc.), skip silently -- no orphan messages.

**Why not skip Slack entirely?** Because there's a real scenario: CM sees winner notification at 6am, plans to scale it after their morning review, but by 12pm the ratio degraded. Without the thread reply, they'd scale based on stale info. The thread reply catches that. Low noise because it's in the thread, not a new top-level message.

### 3. Edge Cases Flagged

**1. Opp reclassification mid-flight.** An IM marks something as opportunity, then Grace or the IM reclassifies it back to possibility. Opp count drops from 2 to 1. Variant was flagged as winner, now fails the min-opps gate. This is the most realistic "speak too soon" scenario. Covered by the rescission logic above.

**2. Campaign with all variants winning.** If 4/4 active variants in a step are all under 2500:1, they're all flagged as winners. That's correct -- it means the campaign/list/segment is strong, not any particular copy. But the CM might read it as "I don't need to iterate" when actually they should be asking "why is this segment so good, can I launch more campaigns against it?" Consider adding a campaign-level roll-up note when 3+ variants in a step are all winning: "All variants performing well -- consider expanding this segment." That's a one-liner in the notification, not a new system.

**3. Winners in finished/dying campaigns.** A variant is technically "winning" but the campaign has 50 uncontacted leads left. The CM gets "SCALE THIS" right next to "LEADS EXHAUSTED." These are both already on the dashboard -- no system-level conflict. But worth noting in the notification: cross-reference leads status. If the same campaign has a LEADS_EXHAUSTED item, append to the winner notification: "Note: this campaign is low on leads. Scale by duplicating copy to a new campaign, not increasing volume on this one." That's a detail lookup, not new logic -- you already have leads status in dashboard_items.

**4. Ghost re-enable interaction.** Phase 4 persistence monitor catches variants that CMs manually re-enable after CC killed them. No interaction with winners -- a re-enabled variant that then performs well would naturally qualify as a winner on a future scan. No edge case here.

**5. First-day false positives.** A brand new campaign gets 500 sends in the first few hours, 2 quick opps, ratio = 250:1. Min sends gate (1,900 for Google) blocks this. Good. But if the campaign ramps to 2,000 sends with 2 opps by the next scan (1,000:1), that's technically a winner. Probably legitimate -- 2 opps in 2K sends is strong signal. The min-opps-2 guard is doing the work here.

### 4. Dashboard Rendering

Green in Action Required. Add `INFO` severity:

- CRITICAL (red) = BLOCKED, DISABLED, LEADS_EXHAUSTED
- WARNING (yellow) = LEADS_WARNING
- INFO (green) = WINNING

Sort order: CRITICAL first, then WARNING, then INFO. Winners don't push action items down the page -- they sit below the fires.

The CM Dashboard V2 already has severity-based rendering. Adding a green color for INFO is a CSS change + one conditional in the frontend.

### 5. Sibling Features -- Boosting Positives

Three that belong in the same TDD because they share the same data path (winner evaluation runs during Phase 2, same analytics):

**a) Variant Diversity Nudge**
When a winning variant is in a step with only 1-2 other active variants, add to the notification: "This step has only 2 active variants. Add more to test against your winner."

This directly maps to what CMs already do (Carlos: "I add a NEW variant and turn off the old one"). The system already knows active variant count per step (it's in `safetyCheck`). Zero new data, just a conditional line in the notification template. ~5 lines.

**b) Campaign-Level Winner Roll-Up**
If 2+ steps in the same campaign have winning variants, that's a campaign-level signal. Add a separate notification: "Campaign [name] has winning variants in Steps 1 and 3. This campaign is a strong candidate for expanded volume or duplication."

This is an aggregation pass after per-variant evaluation. Collect all winner entries by campaign_id, count unique steps, flag if >= 2. ~15 lines in the Phase 2 loop. New notification type `CAMPAIGN_WINNING` or just a line in the morning digest.

**c) Morning Digest Winner Summary**
The 8am digest currently shows: action items, kills since yesterday, re-enables. Add: "Top performers: [Campaign X] Variant B (760:1), [Campaign Y] Variant D (1,100:1)."

This gives CMs a daily highlight reel without them needing to check the dashboard. The data is already being collected in audit_logs with action `WINNER_DETECTED`. The digest query just pulls the top N by ratio from the last 24h. ~20 lines in `sendMorningDigest()`.

---

**Scope trade proposed:** Drop the two-tier system (WINNER/STRONG). One tier, one threshold, three sibling features. Net complexity is about the same, but the value surface is wider.

---

## Sam's Decisions Needed

Sam has responses to the above. Continue this discussion using /product persona, then once design is locked, update the spec at `builds/auto-turn-off/specs/2026-03-23-scale-winners-spec.md` and hand off to /technical.
