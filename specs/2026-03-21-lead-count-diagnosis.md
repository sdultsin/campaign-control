# Lead Count Mismatch Diagnosis

**Date:** 2026-03-21
**Investigator:** Claude (triggered by 6pm validation audit)
**Status:** Root cause confirmed, fix proposed

---

## Root Cause: Hypothesis 1 CONFIRMED

**`contacted_count` from the Instantly analytics API is a lifetime accumulator that never resets when leads are deleted.**

Meanwhile, `leads_count` reflects only the **current** leads in the campaign. When CMs delete contacted leads and upload fresh batches, the two values diverge:

- `contacted_count` keeps growing (includes contacts with now-deleted leads)
- `leads_count` resets to reflect current leads only
- Eventually `contacted_count >= leads_count` → CC computes `uncontacted = 0` → false EXHAUSTED

---

## Evidence

### Supabase audit log (6pm run, worker `ff07af8`)

| Campaign | leads_total | leads_contacted | CC uncontacted | leads_active (real) | Action | Correct? |
|----------|-------------|-----------------|----------------|---------------------|--------|----------|
| Cleaning (Alex) | 21,909 | 22,486 | **0** | 21,867 | EXHAUSTED | **WRONG** — 21,867 active |
| Restaurants (Alex) | 23,228 | 22,494 | **734** | 23,157 | WARNING | **WRONG** — 23,157 active |
| General (Alex) | 21,420 | 7,500 | **13,920** | 14,098 | WARNING | **~Correct** — 14,098 active |
| Property V2 (Samuel) | 36,271 | 36,761 | **0** | 30,029 | EXHAUSTED | **WRONG** — 30,029 active |

### Proof: contacted is lifetime, not current

For campaigns **without** lead cycling, `contacted ≈ completed + bounced`:
- **General:** contacted=7,500, completed+bounced = 7,322+179 = 7,501 ✓

For campaigns **with** lead cycling, `contacted >> completed + bounced`:
- **Cleaning:** contacted=22,486, completed+bounced = 42+108 = 150 → **22,336 phantom contacts from deleted leads**
- **Property V2:** contacted=36,761, completed+bounced = 6,242+52 = 6,294 → **30,467 phantom contacts**
- **Restaurants:** contacted=22,494, completed+bounced = 71+99 = 170 → **22,324 phantom contacts**

### Batch vs per-campaign analytics: NO difference

Both endpoints return identical `contacted` values. The batch endpoint is not the problem — the underlying `contacted_count` field itself is the problem.

### count_leads endpoint returns accurate data

The Instantly `count_leads` endpoint returns status breakdowns (active, completed, bounced, skipped, unsubscribed) that reflect **current** campaign state only:

| Campaign | count_leads total | active | completed | bounced | skipped |
|----------|------------------|--------|-----------|---------|---------|
| Cleaning (Alex) | 21,909 | 21,850 | 43 | 7 | 9 |
| Restaurants (Alex) | 23,228 | 23,133 | 71 | 17 | 7 |
| General (Alex) | 21,420 | 13,921 | 7,321 | 178 | 0 |
| Property V2 (Samuel) | 36,271 | 29,998 | 6,242 | 0 | 31 |

The `active` count is the true "leads remaining to be contacted" — it only counts leads currently in the campaign that haven't completed the sequence.

---

## Additional Finding: `leads_active` in audit log is derived, not real

CC computes `active: totalLeads - completed` (index.ts lines 1540, 1619, 1680) rather than fetching it from count_leads. This derivative is closer to reality than `uncontacted` but still wrong because it doesn't account for bounced/skipped leads.

---

## Proposed Fix

### Option A: Use count_leads `active` as uncontacted (RECOMMENDED)

Replace the `totalLeads - contacted` formula with the `active` count from the count_leads endpoint.

**What changes:**
1. For each leads-check candidate, call `count_leads(workspaceId, campaignId)` via the Instantly MCP
2. Use the returned `active` count directly as `uncontacted`
3. Use the returned `total_leads` as `totalLeads`
4. Drop the batch analytics dependency for lead depletion (keep it for other purposes)

**Why `active` is the right metric:**
- `active` = leads in the campaign that haven't completed the sequence
- This is exactly what "uncontacted/available leads" means operationally
- It's immune to lead cycling — only counts current leads in their current state
- It's already validated: for General (no-cycle control), `active` (13,921) ≈ CC's correct uncontacted (13,920)

**Performance impact:**
- Current: 1 batch call per workspace (~17 calls total)
- Proposed: 1 count_leads call per campaign being checked
- Leads check only runs for campaigns with active leads monitoring, not all 63
- Each call is fast (<500ms via MCP)
- Acceptable tradeoff for accuracy

**Code changes needed:**
1. `src/index.ts` lines 1440-1485: Replace batch analytics lookup with per-campaign count_leads call
2. `src/leads-monitor.ts`: Update `computeUncontacted` to accept active count directly (or remove it — just use active)
3. `src/instantly-direct.ts`: Add a direct API `countLeads` method that hits `/leads/count` or `/leads?limit=0` with status breakdown parsing
4. Keep batch analytics for audit logging but not for verdicts

### Option B: Compute uncontacted from count_leads breakdown

Instead of trusting a single `active` field, compute:
```
uncontacted = total_leads - completed - bounced - skipped - unsubscribed
```

This is mathematically equivalent to `active` and serves as a cross-check. Slightly more defensive.

### Option C: Hybrid — batch analytics + count_leads correction

Keep batch analytics for efficiency but add a count_leads cross-check for campaigns where `contacted > total * 0.8`. Only call count_leads when the batch data looks suspicious.

**Pro:** Fewer API calls for healthy campaigns
**Con:** Adds complexity, still relies on batch analytics as primary source

---

## Validation Plan

1. **Before deploying:** Run the fix in dry-run mode and compare verdicts against current production for all 63 campaigns
2. **Spot-check:** For the 4 campaigns investigated here, verify the new verdicts match reality:
   - Cleaning → should be HEALTHY (21,850+ active vs 30K daily limit... actually WARNING because active < dailyLimit, but NOT exhausted)
   - Restaurants → should be HEALTHY/WARNING (23,133 active)
   - General → should stay WARNING (13,921 active < 30K daily limit)
   - Property V2 → should be HEALTHY/WARNING (29,998 active), NOT exhausted
3. **Monitor:** After deploy, compare Slack notifications against UI for 2-3 runs

---

## Why Hypothesis 2, 3, 4 Are Not the Cause

- **H2 (Batch vs per-campaign divergence):** Both return identical data. Not the issue.
- **H3 (leads_count vs actual count):** `leads_count` from analytics matches count_leads `total_leads`. The total is accurate; it's `contacted` that's wrong.
- **H4 (contacted definition differs):** The definition isn't the issue — the issue is that contacted is lifetime while total is current. For non-cycled campaigns, the formula works perfectly.
