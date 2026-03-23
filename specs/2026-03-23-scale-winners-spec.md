# Scale Winners - Feature Spec

**Date:** 2026-03-23
**Status:** DRAFT - awaiting review
**Author:** Claude (product agent)

---

## Problem

Campaign Control identifies and kills losers. The same data can identify winners. Today CMs manually scan Instantly analytics to find high-performing variants - this is slow, inconsistent, and gets deprioritized when fires need putting out. Winners sit unscaled because nobody noticed them.

## Solution

Add winner detection to the existing Phase 2 evaluation scan. When a variant is crushing it, send a "SCALE THIS" notification to the CM's Slack channel with performance data and a suggested action.

---

## 1. Winner Criteria

### Thresholds

Winner detection reuses the same `threshold` resolved per-campaign by `resolveThreshold()` (provider-based: Google 3800, SMTP 4500, Outlook 5000; product overrides for ERC/S125).

Two tiers, aligned with CM-validated benchmarks from `kpi-framework.md`:

| Tier | Min Sends | Min Opps | Max Ratio | What It Means |
|------|-----------|----------|-----------|---------------|
| **WINNER** | threshold * 0.5 | 5 | threshold * 0.5 | Confirmed winner. Ratio 2x better than kill line. |
| **STRONG** | threshold * 0.5 | 3 | threshold * 0.75 | Early winner signal. Strong enough to flag. |

**Google example (threshold = 3800):**
- WINNER: >= 1,900 sends, >= 5 opps, ratio <= 1,900:1 (e.g., 3,800 sent / 4 opps = 950:1)
- STRONG: >= 1,900 sends, >= 3 opps, ratio <= 2,850:1 (e.g., 5,700 sent / 3 opps = 1,900:1)

### Why these numbers

- **Min sends = threshold * 0.5**: Half the kill gate. Enough data to be meaningful without waiting until the kill threshold. A variant with 1,900+ Google sends has been in market long enough to trust.
- **Min opps = 3/5**: Directly from CM benchmarks. "3 opps = early signs, 5 opps = winner" - this is how CMs already think about it.
- **Ratio ceiling**: A variant performing at 2x the minimum acceptable rate (WINNER) or 1.33x (STRONG) is demonstrably outperforming. This is absolute performance, not relative to siblings - a variant can be a winner even if it's the only one in its step.

### Evaluation function

```
evaluateWinner(sent, opportunities, threshold) -> 'WINNER' | 'STRONG' | null
```

- If sent < threshold * 0.5 -> null (insufficient data)
- If opportunities < 3 -> null (too few opps)
- ratio = sent / opportunities
- If opportunities >= 5 AND ratio <= threshold * 0.5 -> 'WINNER'
- If opportunities >= 3 AND ratio <= threshold * 0.75 -> 'STRONG'
- Otherwise -> null

No interaction with kill logic. A variant can't be both a kill candidate and a winner (kills require ratio > threshold; winners require ratio < threshold * 0.75). These are non-overlapping regions.

---

## 2. Notification Format

### Slack message

Same CM channels as kill notifications (`CM_MONITOR_CHANNELS`). Same `NotificationCollector` pattern - grouped parent message + thread replies.

**Parent message (grouped):**

```
:trophy: Winning Variants Detected (3)
```

**Thread reply (per variant):**

```
Workspace: Renaissance 2
Campaign: RG 2237 Finvera Painters Eyver
Step 1, Variant B - WINNER

Emails sent: 3,800
Opportunities: 5
Ratio: 760:1 (threshold: 3,800:1 - 5x better)

Suggested action: Scale volume on this campaign or duplicate winning copy to new campaigns.
```

For STRONG tier, replace "WINNER" with "STRONG SIGNAL" and suggested action with: "Monitor closely. 2 more opportunities confirms this as a winner."

### Emoji mapping

- WINNER -> `:trophy:`
- STRONG -> `:chart_with_upwards_trend:`

### Morning digest integration

Add winner counts to the existing `sendMorningDigest()` summary line:

```
Since yesterday: 3 variants turned off, 1 re-enabled, 2 winners detected
```

---

## 3. Dashboard Integration

### New item type: `WINNING`

Add to `DashboardItemType`:

```typescript
type DashboardItemType = 'BLOCKED' | 'DISABLED' | 'LEADS_EXHAUSTED' | 'LEADS_WARNING' | 'WINNING';
```

### New severity: `INFO`

Winners aren't problems. They need a distinct severity that renders differently (green, not red/yellow).

```typescript
type DashboardSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
```

### Dashboard item context

```typescript
{
  item_type: 'WINNING',
  severity: 'INFO',
  cm: 'EYVER',
  campaign_id: '...',
  campaign_name: 'RG 2237 Finvera Painters Eyver',
  workspace_id: 'renaissance-2',
  workspace_name: 'Renaissance 2',
  step: 1,
  variant: 1,
  variant_label: 'B',
  context: {
    tier: 'WINNER',       // or 'STRONG'
    sent: 3800,
    opportunities: 5,
    ratio: '760.0',
    threshold: 3800,
    performance_multiple: '5.0x',   // how many times better than threshold
  }
}
```

### Resolution

WINNING items auto-resolve when the variant no longer meets winner criteria on the next scan (e.g., ratio degraded). They also resolve if the variant gets killed (shouldn't happen, but defensive). Handled by existing `resolveStaleItems()` - no changes needed to resolution logic.

---

## 4. Dedup / Frequency Rules

### KV dedup key

```
winner:{campaignId}:{stepIndex}:{variantIndex}:{tier}
```

### TTL

- WINNER: 7 days (same as kill dedup). Once flagged, don't re-flag unless tier changes.
- STRONG: 3 days. Shorter because STRONG can upgrade to WINNER.

### Tier upgrade re-notification

If a variant was previously notified as STRONG and now qualifies as WINNER, send a new notification. The STRONG dedup key won't block the WINNER key (different key suffix).

### Previously BLOCKED variants

If a variant was BLOCKED (last active variant exceeding threshold) and subsequently got enough opps to become a winner, the BLOCKED dashboard item gets auto-resolved by `resolveStaleItems()` on the next scan. The WINNING item gets upserted in the same scan. No special handling needed - existing resolution logic covers this.

---

## 5. Audit Log

### New action: `WINNER_DETECTED`

```typescript
type AuditAction = ... | 'WINNER_DETECTED';
```

Writes to both KV and Supabase `audit_logs` table via existing `writeAuditLog()` and `writeAuditLogToSupabase()`.

### Audit entry

Same `AuditEntry` shape. Fields:

```typescript
{
  timestamp: '2026-03-23T15:00:00.000Z',
  action: 'WINNER_DETECTED',
  workspace: 'Renaissance 2',
  workspaceId: 'renaissance-2',
  campaign: 'RG 2237 Finvera Painters Eyver',
  campaignId: '...',
  step: 1,
  variant: 1,
  variantLabel: 'B',
  cm: 'EYVER',
  product: 'FUNDING',
  trigger: {
    sent: 3800,
    opportunities: 5,
    ratio: '760.0',
    threshold: 3800,
    rule: 'WINNER: ratio 760:1 is 5.0x better than threshold 3800:1'
  },
  safety: {
    survivingVariants: 4,
    notification: null
  },
  dryRun: false
}
```

### RunSummary addition

Add `winnersDetected: number` to `RunSummary` interface.

---

## 6. Code Changes

### Files to modify

| File | Change | Est. Lines |
|------|--------|-----------|
| `src/evaluator.ts` | Add `evaluateWinner()` function | ~20 |
| `src/types.ts` | Add `WINNER_DETECTED` to AuditEntry action union, `WINNING` to DashboardItemType, `INFO` to DashboardSeverity, `winnersDetected` to RunSummary | ~8 |
| `src/config.ts` | Add `WINNER_DEDUP_TTL_SECONDS`, `STRONG_DEDUP_TTL_SECONDS`, winner threshold multipliers | ~8 |
| `src/slack.ts` | Add `formatWinnerTitle()`, `formatWinnerDetails()`, add `WINNER` to `SlackNotificationType` and `GROUP_TITLES`, update morning digest | ~45 |
| `src/dashboard-state.ts` | Add winner detection results to `buildDashboardState()` input, upsert WINNING items | ~25 |
| `src/index.ts` | In Phase 2 loop: after `evaluateStep()`, call `evaluateWinner()` on each active variant's analytics. Collect winners, dedup via KV, queue notifications, write audit logs. Add winners to dashboard state call. Update RunSummary. | ~60 |

**Total estimated: ~166 lines added/modified**

### What stays the same

- Kill logic: untouched. Winner evaluation happens AFTER kill evaluation on each step.
- Threshold resolution: reused as-is.
- Channel routing: reused as-is. Winners go to same CM channels.
- NotificationCollector: reused as-is with new type.
- Supabase write functions: reused as-is (audit log shape is compatible).

---

## 7. Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Variant with 100 sends and 1 opp | Not flagged. Min sends = threshold * 0.5 (1,900 for Google). Prevents false positives on tiny samples. |
| Campaign with only 1 variant | Still evaluated. Winner criteria are absolute, not relative. A solo variant can be a winner. |
| Previously BLOCKED variant that got opps | BLOCKED auto-resolves. If now meets winner criteria, WINNING item created. Clean transition. |
| Variant in DRY_RUN CM | Winners still detected and logged (dashboard populates) but Slack notification suppressed, consistent with kill behavior. |
| Non-pilot CM campaigns | Not evaluated. Winner detection follows same `PILOT_CMS` filter. Could extend to all CMs as an onboarding hook (future). |
| OFF campaigns (weekend) | Same threshold adjustment (1.2x buffer) applies. Winner criteria scale proportionally. |
| Variant that was a winner but degrades | WINNING dashboard item auto-resolves on next scan when criteria no longer met. No "un-winner" notification - just silently removed. |

---

## 8. What This Does NOT Do (Future Path)

Noted but not spec'd:

1. **Auto-generate variants from winning copy** - requires Campaign Machine Gun integration
2. **Auto-scale volume** - increase daily send limits via Instantly API
3. **Relative winner detection** - compare siblings within a step to find the BEST variant (this spec uses absolute thresholds only)
4. **Cross-campaign winner patterns** - identify winning copy themes across campaigns
5. **Feedback loop integration** - winner data feeds copy optimization engine

---

## 9. Execution Instructions

1. `/technical` - implement per this spec
2. `tsc` - confirm clean compile
3. `/cc-review` - adversarial review loop until approved
4. Deploy via `./deploy.sh`
5. Verify: trigger a manual run, confirm winner notifications appear for known high-performing variants
6. Handoff doc to `specs/` with deployment hash and verification results
