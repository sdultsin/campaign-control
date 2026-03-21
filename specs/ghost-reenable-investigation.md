# Ghost Re-Enable Investigation

**Date:** 2026-03-18
**Status:** Open — root cause identified, fix pending
**Severity:** High — undermines kill reliability

---

## Problem

During the 2026-03-18 pilot revert, 68 of 94 confirmed-disabled variants showed as `already_enabled` when we tried to re-enable them hours later. The system verified each disable succeeded (re-fetched and checked `v_disabled === true`), yet the disables didn't persist.

- Only 1 RE_ENABLED and 1 CM_OVERRIDE in audit logs
- CMs did not manually re-enable 68 variants across 30+ campaigns in a few hours
- KILLS_ENABLED was toggled to false at some point, but audit entries are only written on verified success

## Root Cause: Last-Write-Wins Race on Instantly API

When multiple variants on the same campaign are killed in the same cron run, each kill:

1. Fetches `campaignDetail` via `getCampaignDetails()`
2. Calls `structuredClone(campaign.sequences)`
3. Sets `v_disabled = true` on ONE variant
4. Pushes the **entire `sequences` payload** via `update_campaign`
5. Verifies immediately — passes because it reads its own write

The race:
```
Kill A: fetch snapshot(T0) → clone → disable variant[0] → push → verify ✓
Kill B: fetch snapshot(T0) → clone → disable variant[1] → push → verify ✓
                                                           ↑
                                               B's payload has variant[0] ENABLED
                                               because B cloned from pre-A state
```

Kill B's update overwrites Kill A's disable. Both verifications pass because each reads its own write before the next operation clobbers it.

### Evidence

- 68/94 = 72% ghost re-enable rate
- Campaigns with the most killed variants had the highest re-enable rates
- The 26 that stayed disabled were likely the LAST variant killed per campaign (no subsequent write to overwrite them)

### Contributing factors

- `MAX_KILLS_PER_RUN = 10` means up to 10 kills per cron run, potentially multiple per campaign
- No locking or batching per campaign — each kill is a separate read-modify-write cycle
- Instantly API appears to use last-write-wins on the full sequences object (no field-level merge)

## What This Does NOT Explain

- Whether Instantly has internal dedup/cache behavior that also contributes
- Whether campaign edits in the Instantly UI reset `v_disabled` flags
- Whether there's a TTL or auto-recovery mechanism in Instantly's backend

## Needs

1. **Immediate fix:** Batch all variant disables per campaign into a single `update_campaign` call
2. **Observability:** Kill persistence monitor to detect ghost re-enables
3. **Escalation:** Confirm with Instantly CTO whether `update_campaign` uses last-write-wins or merge semantics
