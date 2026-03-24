# Scale Winners - Technical Design Document

**Date:** 2026-03-23
**Status:** LOCKED - ready for /technical build spec
**Author:** Sam + Claude (product agent)

---

## Summary

Add winner detection to Campaign Control's Phase 2 evaluation scan. When a variant is performing well, surface it on the CM dashboard and send a one-time Slack notification. No action is taken on the variant -- this is informational only.

---

## Context Files for /technical

- `builds/auto-turn-off/specs/2026-03-23-scale-winners-spec.md` -- original draft spec (superseded by this TDD on all conflicting points)
- `builds/auto-turn-off/src/evaluator.ts` -- current kill logic
- `builds/auto-turn-off/src/config.ts` -- thresholds, workspace configs
- `builds/auto-turn-off/src/slack.ts` -- notification formatting
- `builds/auto-turn-off/src/dashboard-state.ts` -- dashboard item types
- `builds/auto-turn-off/src/types.ts` -- all type definitions
- `builds/auto-turn-off/src/index.ts` -- main loop (Phase 2)

---

## Locked Product Decisions

### 1. Winner Criteria

**One tier only: WINNING.** No STRONG tier, no two-tier system.

**Thresholds (0.66x kill line):**

| Infra | Kill Threshold | Winner Threshold |
|-------|---------------|-----------------|
| Google | 3,800 | 2,500 |
| SMTP/OTD | 4,500 | 3,000 |
| Outlook | 5,000 | 3,300 |

**Guardrails:**
- Min opps: 2 (eliminates single-opp flukes)
- Min sends: kill_threshold * 0.5 (1,900 for Google -- variant must have been in market long enough)

**OFF campaigns:** Apply the existing 1.2x buffer to the winner threshold. Google OFF winner threshold = 2,500 * 1.2 = 3,000:1.

**Evaluation logic:**
- If sent < kill_threshold * 0.5 -> not a winner (insufficient sends)
- If opportunities < 2 -> not a winner (insufficient signal)
- ratio = sent / opportunities
- If ratio <= winner_threshold -> WINNING
- Otherwise -> not a winner

Winner threshold = kill_threshold * 0.66, further multiplied by 1.2 for OFF campaigns (same buffer kill logic uses).

No interaction with kill logic. A variant cannot be both a kill candidate (ratio > kill_threshold) and a winner (ratio <= kill_threshold * 0.66). These are non-overlapping ranges.

### 2. Dashboard Behavior

**New item type:** `WINNING`
**Severity:** `INFO` (green)

**Sort order:** CRITICAL (red) > WARNING (yellow) > INFO (green). Winners sit below all action items on the dashboard.

**Lifecycle:**
- WINNING item appears when variant meets winner criteria.
- Re-evaluated every scan (4x daily). If the variant no longer meets criteria (ratio drifts above winner threshold, or opps drop below 2), the item silently auto-resolves. Green row disappears. No degradation notification, no alarm.
- If the CM presses "Done," the item is dismissed and permanently deduped -- never re-appears for that variant.
- If the variant degrades all the way to kill territory (ratio > kill_threshold), normal kill logic handles it. No special interaction.

**No WINNER_DEGRADED item type.** If a winner stops winning, it silently disappears. If it becomes bad enough to kill, the kill system catches it.

### 3. Slack Notifications

**One notification per variant, ever.** When a variant first qualifies as WINNING, send one Slack notification to the CM's channel. Same channel routing as kill notifications (CM_MONITOR_CHANNELS).

**Dedup:** Permanent KV flag with no TTL. Key: `winner:notified:{campaignId}:{step}:{variant}`. Once set, that variant is never re-notified regardless of status changes.

**No degradation Slack messages.** If a winner stops winning, no thread reply, no follow-up. Dashboard handles it silently.

**Format:** Use existing NotificationCollector pattern -- grouped parent message + thread replies.

Parent:
```
:trophy: Winning Variants Detected (3)
```

Thread reply (per variant):
```
Workspace: Renaissance 2
Campaign: RG 2237 Finvera Painters Eyver
Step 1, Variant B - WINNING

Emails sent: 3,800
Opportunities: 5
Ratio: 760:1 (threshold: 3,800:1 - 5x better)
```

No "suggested action" line. The notification itself is the nudge.

### 4. Leads-Exhausted Cross-Reference

When a variant is flagged as WINNING and the same campaign has an active LEADS_EXHAUSTED or LEADS_WARNING dashboard item, append to the Slack thread reply:

```
Note: This campaign is low on leads. Add more leads - this is a well-performing campaign.
```

This is a lookup against existing dashboard_items in the same scan. No new data sources.

### 5. All-Variants-Winning Roll-Up

When 3+ variants in a single step are all WINNING, add a line to the parent Slack message or as an additional thread reply:

```
All variants in Step 1 are performing well. Add more leads to this campaign.
```

NOT "expand the segment." Same leads, same segment, more volume.

### 6. Campaign-Level Winner Roll-Up

When 2+ steps in the same campaign have winning variants, add a notification:

```
Campaign [name] has winning variants in Steps 1 and 3. Strong candidate for increased volume.
```

This is an aggregation pass after per-variant evaluation. Collect all winner entries by campaign_id, count unique steps, flag if >= 2.

### 7. Morning Digest Integration

Add to the existing daily 8am digest. After the current summary (kills, re-enables, etc.), add:

```
Top performers (last 24h): [Campaign X] Variant B (760:1), [Campaign Y] Variant D (1,100:1)
```

Pull from audit_logs where action = WINNER_DETECTED in the last 24 hours. Top N by ratio (best performers first).

### 8. Audit Log

New action: `WINNER_DETECTED`

Same AuditEntry shape. Writes to KV + Supabase via existing writeAuditLog() and writeAuditLogToSupabase().

Add `winnersDetected: number` to RunSummary.

### 9. Scope

**Pilot CMs only.** Winner detection follows the same PILOT_CMS filter as kills. Sam will verify against Instantly UI for the first few runs before expanding.

**No hold-back needed.** Winners are informational only -- no writes to Instantly, no variant disabling. Can go live immediately after verification.

---

## What This Does NOT Do

- No auto-scaling (increasing send limits via Instantly API)
- No auto-generating variants from winning copy
- No relative winner detection (comparing siblings within a step)
- No cross-campaign winner pattern detection
- No variant diversity nudge (dropped -- redundant with core feature)
- No WINNER_DEGRADED notifications (dropped -- silent auto-resolve + kill logic covers it)
- No Slack thread replies on degradation (dropped -- dashboard handles it)

---

## Execution Instructions

1. `/technical` -- write build spec from this TDD, implement
2. `tsc` -- confirm clean compile
3. `/cc-review` -- adversarial review loop until approved
4. Deploy via `./deploy.sh`
5. Verify: trigger a manual run, confirm winner notifications appear for known high-performing variants
6. Handoff doc to `specs/` with deployment hash and verification results
