# Handoff: Fix Leads Exhaustion Detection (uncontacted calculation)

**Date:** 2026-04-03
**Files changed:** `src/index.ts` (lines ~2311-2351)

## What Changed

Fixed the `uncontacted` leads calculation in Phase 3 (leads depletion monitor). Previously, `uncontacted` was set to `active` (leads still in the sequence), which includes leads that HAVE been contacted but are waiting for their next step. Now `uncontacted` is correctly calculated as `totalLeads - data.contacted`, where `data.contacted` comes from the batch analytics `contacted_count` field (lifetime count of all leads emailed at least once).

Also added a TODO comment and warning log to the MCP fallback path noting its lead counts are unreliable for the same reason.

## Why

Leads exhaustion detection never fired since deployment. `leads_exhausted = 0` across all run summaries. Two campaigns were fully exhausted (44K loaded, 44K sequenced, ~0 truly uncontacted) but CC reported them as HEALTHY with ~43,596 "uncontacted" leads because `active` includes in-sequence leads that have already been contacted.

Spec: `specs/2026-04-03-cc-leads-uncontacted-fix.md`

## How to Verify Post-Deploy

1. Check next run summary: `leads_exhausted > 0` and `leads_warnings > 0` (HVAC and Restaurant campaigns should trigger EXHAUSTED immediately)
2. Check `leads_audit_logs` table for new entries with action = 'LEADS_EXHAUSTED'
3. Compare the `contacted` and `active_in_sequence` (uncontacted) values in the audit entry - they should now differ (previously they were both derived from the same wrong `active` calculation)
4. Dashboard should show LEADS_EXHAUSTED items for affected campaigns

## Risk Assessment

- Low risk. The `data.contacted` field was already being fetched and used elsewhere (warm leads filter at line 729). Only the leads depletion calculation was using the wrong value.
- Edge case: if CMs delete and re-upload leads, `contacted` can exceed `leads_count`. `Math.max(0, ...)` clamps to 0, correctly triggering EXHAUSTED. Safe direction.
- MCP path (dead code, `INSTANTLY_MODE` defaults to "direct") is unchanged in behavior, just documented as unreliable.
- KV dedup (48h TTL per campaign) prevents alert flooding.

## VERSION_REGISTRY Row

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| pending | 2026-04-03 | Fix uncontacted = active to uncontacted = totalLeads - contacted | Pending deploy |
