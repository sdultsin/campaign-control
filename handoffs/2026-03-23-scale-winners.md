# Scale Winners Handoff

**Date:** 2026-03-23
**Version:** `c90bbb5`
**Spec:** `specs/2026-03-23-scale-winners-build-spec.md`
**TDD:** `specs/2026-03-23-scale-winners-tdd.md`
**Status:** Deployed to production

---

## What Was Built

Winner detection added to Campaign Control's Phase 1 evaluation scan. When a variant's sent:opp ratio is at or below 0.66x of the kill threshold, it's flagged as WINNING. Informational only -- no Instantly API writes, no variant state changes.

### Winner Criteria

- **Threshold:** `kill_threshold * 0.66` (Google: ~2,508, SMTP/OTD: ~2,970, Outlook: 3,300)
- **Min sends:** `kill_threshold * 0.5` (variant must have been in market long enough)
- **Min opps:** 2 (eliminates single-opp flukes)
- **OFF campaigns:** Inherit the existing 1.2x buffer via `resolveThreshold()`

Winner and kill ranges are non-overlapping. The gap between 0.66x and 1.0x of kill threshold is neutral territory.

### Surfaces

1. **CM Dashboard:** WINNING items appear as INFO severity (green), sorted below all CRITICAL/WARNING items. Auto-resolve silently when variant drifts above threshold. CM "Done" dismiss is permanent (never re-appears).
2. **Morning Digest (8am ET):** "Top performers (last 24h)" line appended after status line. Pulls from WINNER_DETECTED audit logs, sorted by best ratio, top 5.
3. **Audit Logs:** `WINNER_DETECTED` action in both KV and Supabase. Full trigger context (sent, opps, ratio, thresholds).

### Notifications

- **Slack dedup:** Permanent KV key `winner:notified:{campaignId}:{step}:{variant}` with no TTL. One notification per variant, ever. Only set when NOT in dry-run mode.
- **Leads cross-reference:** If a winning variant's campaign has an active `leads-exhausted` or `leads-warning` KV key, appends: "Note: This campaign is low on leads. Add more leads - this is a well-performing campaign."
- **All-variants-winning roll-up:** When 3+ variants in a single step are all WINNING, adds "All variants in Step N are performing well. Add more leads to this campaign."
- **Campaign-level roll-up:** When 2+ steps in the same campaign have winning variants, adds "Campaign [name] has winning variants in Steps X and Y. Strong candidate for increased volume."
- **Roll-ups only fire when new winners are detected** (gated on `totalWinnersDetected > 0`, not on `dashboardWinners.length`).

### Architecture

Follows the CampaignResult pattern from the pre-expansion fixes (`8a74345`):
- `result.winners: WinnerEntry[]` -- all qualifying winners for a campaign
- `result.winnersDetected: number` -- count of newly detected (not deduped) winners
- Sequential tally loop aggregates to `dashboardWinners` and `totalWinnersDetected`
- No shared state mutation inside the concurrent callback

Zero extra API calls -- winner evaluation piggybacks on Phase 1's existing analytics + threshold data.

---

## Files Modified

| File | Changes |
|------|---------|
| `src/config.ts` | `WINNER_THRESHOLD_MULTIPLIER` (0.66), `WINNER_MIN_OPPS` (2), `WINNER_MIN_SENDS_MULTIPLIER` (0.5) |
| `src/types.ts` | `WinnerEntry` interface, `WINNING` on `DashboardItemType`, `INFO` on `DashboardSeverity`, `WINNER_DETECTED` on `AuditEntry.action`, `winnersDetected` on `RunSummary`, `winners` + `winnersDetected` on `CampaignResult` |
| `src/evaluator.ts` | `evaluateWinner()` function + `WinnerResult` interface |
| `src/slack.ts` | `WINNER` on `SlackNotificationType`, `GROUP_TITLES`, `formatWinnerDetails()`, `formatAllVariantsWinning()`, `formatCampaignWinnerRollup()`, `sendMorningDigest()` updated with `winnersLast24h` |
| `src/dashboard-state.ts` | `winners` parameter on `buildDashboardState()`, WINNING -> INFO dashboard items |
| `src/supabase.ts` | `dismissed_at` guard for WINNING items, `getDashboardDigestData()` queries WINNER_DETECTED, `winners_detected` in run summary write |
| `src/index.ts` | Winner evaluation in Phase 1 step loop, roll-up notifications after Phase 1, dashboard wiring, RunSummary update |

## Database Migration

```sql
ALTER TABLE run_summaries ADD COLUMN IF NOT EXISTS winners_detected integer DEFAULT 0;
```

Applied directly. No new tables.

---

## CC Review Results

Two review rounds:

**Round 1** found 6 issues (2 critical, 2 high, 2 medium):
1. ~~Dedup key set during dry run~~ -- moved inside `!isDryRun` block
2. ~~Dashboard dismissed items un-dismissed~~ -- `upsertDashboardItem` now skips update when `item_type === 'WINNING' && match.dismissed_at`
3. ~~Roll-up spam every scan~~ -- gated on `totalWinnersDetected > 0`
4. ~~Roll-up missing try-catch~~ -- wrapped in error isolation
5. ~~Notification format showed winner threshold~~ -- changed to kill threshold per TDD
6. ~~Digest query string sort~~ -- client-side `parseFloat` sort

**Round 2** (post-CampaignResult rebase) approved with one note: unused `WINNER_THRESHOLD_MULTIPLIER` import in slack.ts (non-blocking).

---

## Verification Queries

```sql
-- Winners detected on this version
SELECT * FROM audit_logs WHERE action = 'WINNER_DETECTED' AND worker_version = 'c90bbb5' ORDER BY timestamp DESC LIMIT 10;

-- Active WINNING dashboard items
SELECT * FROM dashboard_items WHERE item_type = 'WINNING' AND resolved_at IS NULL;

-- Run summary with winner count
SELECT timestamp, winners_detected, campaigns_evaluated, variants_disabled FROM run_summaries WHERE worker_version = 'c90bbb5' ORDER BY timestamp DESC LIMIT 1;
```

---

## What This Does NOT Do

Per TDD section "What This Does NOT Do":
- No auto-scaling (increasing send limits via Instantly API)
- No auto-generating variants from winning copy
- No relative winner detection (comparing siblings within a step)
- No cross-campaign winner pattern detection
- No WINNER_DEGRADED notifications (silent auto-resolve + kill logic covers it)
- No Slack thread replies on degradation
