# Handoff: Lead Count Fix

**Version:** `1802bf2`
**Deployed:** 2026-03-22 ~00:30 UTC
**Specs:** `specs/2026-03-21-lead-count-diagnosis.md`, `specs/2026-03-21-lead-count-fix.md`

---

## What changed

Phase 3 (leads depletion monitor) switched from batch analytics to per-campaign MCP `count_leads`.

**Before:** `uncontacted = leads_count - contacted_count` from batch analytics endpoint. `contacted_count` is a lifetime accumulator that never resets when CMs delete leads. Campaigns with lead cycling got false EXHAUSTED/WARNING verdicts (e.g., Cleaning showed 0 uncontacted when 21,850 leads were active).

**After:** `uncontacted = active` from MCP `count_leads` per campaign. The `active` count reflects current campaign state only and is immune to lead cycling.

## Files changed

- `src/index.ts` — Replaced batch analytics fetch + dual direct/MCP path with single `mcpApi.countLeads()` per candidate. All three audit entry blocks (EXHAUSTED, WARNING, RECOVERED) now use real `active`/`skipped` values.
- `src/leads-monitor.ts` — Deleted `computeUncontacted()` (the broken formula). `evaluateLeadDepletion()` unchanged.
- `src/types.ts` — Added missing `unsubscribed` to `LeadCounts.status` interface. Updated JSDoc comments.

## What to watch

1. **Run duration:** Phase 3 is ~15-20s slower (per-campaign MCP calls vs one batch call per workspace). Monitor total run time stays under the 30-minute lock window.
2. **False EXHAUSTED recovery:** Previously-false EXHAUSTED campaigns (Cleaning, Property V2, etc.) should trigger LEADS_RECOVERED notifications on the next run as their dedup keys clear.
3. **Supabase audit data:** `leads_contacted` now reflects current-state contacted (`completed + bounced + skipped + unsubscribed`) instead of the lifetime accumulator. Historical data before this version has the inflated lifetime value.

## Validation

Compare next run's Slack notifications against Instantly UI for the 4 investigated campaigns:
- Cleaning (Alex) — should NOT be EXHAUSTED (21,850+ active)
- Restaurants (Alex) — should NOT show 734 uncontacted (23,133 active)
- General (Alex) — should stay WARNING (~13,920 active < 30K daily limit)
- Property V2 (Samuel) — should NOT be EXHAUSTED (29,998 active)
