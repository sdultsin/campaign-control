# Fix: Use count_leads for Lead Depletion Monitor

**Date:** 2026-03-21
**Depends on:** [Lead Count Diagnosis](2026-03-21-lead-count-diagnosis.md)
**Problem:** `contacted_count` from analytics API is a lifetime accumulator. When CMs cycle leads, it inflates beyond `leads_count`, causing false EXHAUSTED/WARNING verdicts.
**Fix:** Switch from `totalLeads - contacted` (analytics) to `active` count from `count_leads` (MCP).

---

## What Changes

### 1. `src/index.ts` — Phase 3 leads data source

**Current (lines 1433-1485):** Batch-fetches analytics per workspace, reads `leads_count` and `contacted_count`, computes `uncontacted = totalLeads - contacted`.

**New:** For each leads-check candidate, call `mcpApi.countLeads(workspaceId, campaignId)`. Use `status.active` as the uncontacted count. Use `total_leads` as totalLeads.

```typescript
// REMOVE: lines 1433-1451 (batch analytics fetch block)
// REMOVE: lines 1461-1472 (direct API data extraction)
// KEEP: lines 1473-1484 (MCP fallback) but make it the ONLY path

for (const candidate of leadsCheckCandidates) {
  try {
    // Always use MCP count_leads — analytics contacted_count is a
    // lifetime accumulator that inflates when CMs cycle leads.
    const leadCounts = await mcpApi.countLeads(
      candidate.workspaceId,
      candidate.campaignId,
    );
    const totalLeads = leadCounts.total_leads;
    const s = leadCounts.status;
    const active = s.active;
    const completed = s.completed;
    const bounced = s.bounced;
    const unsubscribed = s.unsubscribed;
    const skipped = s.skipped;

    // active = leads that haven't completed the sequence = true uncontacted
    const uncontacted = active;

    const result = evaluateLeadDepletion(uncontacted, candidate.dailyLimit, totalLeads);
    // ... rest of evaluation unchanged
```

**Key detail:** `mcpApi` is already initialized on line 374-375 regardless of `useDirectApi` mode. No new clients needed.

**Audit entry population:** Replace the derived `active: totalLeads - completed` (lines 1540, 1619, 1680) with the real `active` value from count_leads. Also populate `skipped` with the real value instead of hardcoded 0.

Set `contacted` in the audit entry to `completed + bounced + skipped + unsubscribed` (current-state contacted, not lifetime). This gives accurate audit data.

### 2. `src/leads-monitor.ts` — Update `computeUncontacted`

**Current:** `return Math.max(0, totalLeads - contacted)` — wrong when contacted is lifetime.

**New:** Function becomes a pass-through or is removed. The caller already has `active` from count_leads.

Option A (minimal change — keep function, change semantics):
```typescript
/**
 * Returns the number of leads available for contact.
 * Uses the "active" count from the leads endpoint directly,
 * as the analytics contacted_count is a lifetime accumulator
 * that inflates when CMs cycle leads.
 */
export function computeUncontacted(active: number): number {
  return Math.max(0, active);
}
```

Option B (cleaner — inline it): Remove `computeUncontacted` entirely. Just use `active` directly in index.ts. The function is trivial and the indirection obscures what's happening.

**Recommendation:** Option B. Delete `computeUncontacted`. Keep `evaluateLeadDepletion` unchanged (it doesn't care where `uncontacted` came from).

### 3. `src/instantly-direct.ts` — No changes needed

The existing `countLeads` method (lines 132-159) is not used in the new flow. We're using `mcpApi.countLeads()` (from `instantly.ts`) which calls the MCP tool. No changes to `instantly-direct.ts`.

The `getBatchCampaignAnalytics` method stays for other potential uses but is no longer called by Phase 3.

### 4. `src/types.ts` — Update LeadsAuditEntry comment

Update the JSDoc comment on `active` field (line 86) from:
```typescript
/** Approximated as total - completed when using direct API (analytics endpoint does not return per-status lead counts) */
active: number;
```
To:
```typescript
/** Active leads from count_leads endpoint — leads that haven't completed the sequence */
active: number;
```

Update `skipped` comment (line 89) similarly — it's no longer hardcoded to 0.

Remove `contacted` field comment about analytics if present.

---

## What Does NOT Change

- `evaluateLeadDepletion()` — verdict logic stays the same
- Dedup keys (`leads-warning:`, `leads-exhausted:`) — no change
- KV + Supabase dual-write — no change
- Slack notification format — no change
- Dry run gating — no change
- Phase 1 candidate collection — no change
- Recovery flow (HEALTHY clearing dedup) — no change

---

## Performance Impact

| | Before | After |
|---|--------|-------|
| API calls (leads phase) | 1 batch call per workspace (~17 total) | 1 MCP call per candidate campaign |
| Typical candidates | ~40-50 campaigns with daily_limit set | Same |
| Call speed | ~200ms per batch call | ~300-500ms per MCP call |
| Total time | ~3-4 seconds | ~15-25 seconds |

The leads phase is already the last phase before summary. Adding ~15-20 seconds to a run that takes 2-3 minutes is acceptable. Accuracy is more important than speed here.

If performance becomes a problem later, we can parallelize count_leads calls with a concurrency cap (e.g., 5 at a time). But don't pre-optimize — measure first.

---

## Risk Assessment

**Low risk.** This change:
- Switches data source only (count_leads instead of analytics)
- Does not change evaluation logic, dedup, notifications, or dual-write
- Does not touch kill evaluation (Phase 1), rescan (Phase 2), or snapshot (Phase 4)
- MCP count_leads is a proven, stable tool (used in the MCP fallback path already)
- The `active` count was validated against UI and CC's own correct verdicts in the diagnosis

**Rollback:** Revert the commit. The old batch analytics path can be restored.

---

## Validation Plan

1. **Pre-deploy:** Run with `DRY_RUN=true` and compare new verdicts against the 4 investigated campaigns:
   - Cleaning (Alex) → should be WARNING or HEALTHY (21,850 active), NOT exhausted
   - Restaurants (Alex) → should be WARNING or HEALTHY (23,133 active), NOT exhausted
   - General (Alex) → should stay WARNING (13,921 active < 30K daily limit)
   - Property V2 (Samuel) → should be WARNING or HEALTHY (29,998 active), NOT exhausted

2. **Post-deploy:** Monitor first 2-3 runs. Compare Slack notifications against Instantly UI for spot-check campaigns.

3. **Regression check:** Verify no new false positives/negatives appear for previously-correct campaigns.

---

## Execution Instructions

1. Open a secondary build chat
2. Feed this spec + the diagnosis doc as context
3. Run `/technical` to implement the changes
4. Run `npx tsc --noEmit` to verify compilation
5. Run `/cc-review` until APPROVED
6. Deploy via `./deploy.sh`
7. Write handoff doc to `handoffs/2026-03-21-lead-count-fix.md`
