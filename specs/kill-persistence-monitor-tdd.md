# Kill Persistence Monitor — Technical Design Document

**Author:** Sam + Claude
**Date:** 2026-03-18
**Status:** Draft
**Depends on:** Ghost re-enable investigation
**Codebase:** `builds/auto-turn-off/src/`

---

## 1. Problem

Variants confirmed disabled via the Instantly API silently re-enable without any audit trail. During the 2026-03-18 pilot, 72% of verified kills reverted. We need:

1. A way to detect ghost re-enables as they happen
2. A fix for the root cause (last-write-wins race on multi-variant kills)

## 2. Design: Two Changes

### Change A: Batch kills per campaign (root cause fix)

**Current behavior:** Each variant kill is a separate read-modify-write cycle on the full `sequences` payload. Multiple kills on the same campaign in one run create a last-write-wins race.

**New behavior:** Accumulate all kill candidates for a campaign, then execute them in a single `update_campaign` call.

| Decision | Answer | Rationale |
|----------|--------|-----------|
| When to batch | After all variants in a campaign are evaluated | Prevents the read-modify-write race entirely |
| Scope | Per-campaign, within a single cron run | Cross-run batching adds complexity for marginal benefit |
| Verification | Single getCampaignDetails after the batch update | Verify ALL disabled variants in one call |
| Audit logging | One audit entry per variant (unchanged) | Maintains per-variant granularity for analytics |
| Notification | One Slack message per variant (unchanged) | CMs expect per-variant notifications |
| Fallback | If batch update fails, retry individual variants | Graceful degradation |

**Implementation approach:**

Currently, kills are executed inline as they're discovered during campaign evaluation (inside the variant loop). Change to:

1. During evaluation, collect kill candidates into a `Map<campaignId, KillAction[]>`
2. After all variants in a campaign are evaluated, execute batch kill:
   - Fetch fresh `campaignDetail` (single read)
   - Clone sequences, set `v_disabled = true` on ALL candidates
   - Single `update_campaign` call (single write)
   - Single `getCampaignDetails` verification (single read)
3. Then loop through successful kills for audit logging, notifications, rescan queue

This reduces API calls from `2N` (N reads + N writes + N verifies) to `3` (1 read + 1 write + 1 verify) per campaign.

### Change B: Kill persistence monitor (observability)

**Purpose:** After all Phase 1 kills complete, re-verify that previously killed variants (from this run AND prior runs) are still disabled. Detect and log ghost re-enables.

| Decision | Answer | Rationale |
|----------|--------|-----------|
| What to check | All variants with a `kill:` dedup key in KV | These are variants the system believes are disabled |
| When to check | Phase 4 (new phase, after Phase 3 leads monitor) | Runs every cron cycle, not just when kills happen |
| What counts as ghost | `v_disabled !== true` on a variant that has a `kill:` key and no `RE_ENABLED`/`CM_OVERRIDE`/`MANUAL_REVERT` audit entry | Distinguishes system re-enables from ghost re-enables |
| Action on detection | Log as `GHOST_REENABLE` audit entry + console warning | No auto-fix — just visibility |
| Notification | Single summary message to #cc-sam-agent-tests channel | Don't spam CM channels with system issues |
| Rate limiting | Max 20 persistence checks per run | Avoid excessive API calls on large kill backlogs |
| KV tracking | New key `kill-persist:{campaignId}:{step}:{variant}` with last-verified timestamp | Separate from kill dedup to avoid interference |

**Data flow:**

```
Phase 4: Kill Persistence Monitor
  1. List all KV keys matching `kill:*` prefix
  2. Group by campaign_id
  3. For each campaign (up to 20 checks):
     a. Fetch campaignDetail
     b. For each kill key in this campaign:
        - Check v_disabled on the variant
        - If still disabled: update last-verified timestamp
        - If NOT disabled: log GHOST_REENABLE audit entry
  4. If any ghosts detected, send summary to monitoring channel
```

### New audit action: GHOST_REENABLE

```typescript
// Added to AuditEntry.action union
'GHOST_REENABLE'

// trigger fields:
// - trigger.sent = 0
// - trigger.opportunities = 0
// - trigger.ratio = '0'
// - trigger.threshold = 0
// - trigger.rule = 'Ghost re-enable detected: variant was disabled at {killedAt} but found enabled at {now}'
```

## 3. What This Does NOT Do

- Does not auto-re-disable ghost re-enabled variants (too risky without understanding root cause per-case)
- Does not check variants from before the monitor was deployed
- Does not resolve the Instantly API's merge semantics question (needs CTO escalation)

## 4. Risk

**Change A (batch kills):** Low risk. Reduces API calls and eliminates the race condition. Only behavioral change: kills happen at end of campaign evaluation instead of inline. Net effect: same variants killed, same notifications, fewer API calls.

**Change B (persistence monitor):** Zero risk to existing behavior. Read-only checks on Instantly API. New audit entries and optional notification. No mutations.

## 5. Verification Plan

1. **Batch kill verification:** Deploy, trigger a run, confirm that campaigns with multiple kill candidates result in a single `update_campaign` call (check logs for API call count).
2. **Persistence monitor:** After a run with real kills, check Phase 4 logs. All recently-killed variants should show as "still disabled." If any show as ghost re-enabled, the monitor is working.
3. **Regression:** Confirm existing behavior (notifications, dedup, rescan queue, Supabase writes) is unchanged.
