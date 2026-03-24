# Pre-Expansion Fixes Handoff

**Date:** 2026-03-23
**Version:** `8a74345`
**Spec:** `specs/2026-03-23-pre-expansion-fixes.md`
**Status:** Deployed to production

---

## What Changed

### Fix 1: processWithConcurrency Return-Value Pattern (CRITICAL)

The 633-line callback inside `processWithConcurrency` was mutating 25+ shared variables (`++`, `.push()`, object property writes) across `await` boundaries. JavaScript `++` is not atomic when workers yield -- between read and write, another worker can execute, causing lost increments.

**Before:** `async (campaign) => { totalVariantsKilled++; ... }` (void callback, shared state)
**After:** `async (campaign) => { result.kills++; ... return result; }` (returns `CampaignResult`, sequential tally)

New type in `types.ts`:
```typescript
interface CampaignResult {
  evaluated: boolean;
  cmName: string | null;
  kills: number;
  blocked: AuditEntry[];
  dryRunKills: AuditEntry[];
  warnings: number;
  deferred: number;
  killsPaused: number;
  errors: number;
  leadsCandidate: LeadsCheckCandidate | null;
  snapshot: { totalVariants, activeVariants, disabledVariants, aboveThreshold, steps, health } | null;
}
```

After `processWithConcurrency` completes, a sequential `for (const r of campaignResults)` loop tallies all counters and accumulates snapshot data. Zero shared mutable state inside the callback except `killBudgetRemaining` (bounded race, self-correcting -- see spec Step 5).

**Any new feature that adds counters or dashboard items should add a field to CampaignResult and tally in the sequential loop.**

### Fix 2: Gate RE_ENABLED Audit on enableVariant Success

`reEnableSuccess` boolean flag. Audit entry only written when `enableVariant()` returns true or in dry-run mode. Previously wrote false RE_ENABLED entries to KV + Supabase when the API call failed.

### Fix 3: Warning Dedup Key in Dry-Run Mode

`env.KV.put(dedupKey, '1', ...)` moved before the `if (isDryRun)` branch. Previously dry-run mode re-logged warnings every run (3x/day = 9x inflation per variant).

### Fix 4: Dashboard Step Off-by-One

`${e.step + 1}` changed to `${e.step}` in `dashboard.ts`. Audit entries already store 1-indexed steps (`step: stepIndex + 1` throughout index.ts).

### Fix 5: Rescan + Persistence Monitor KV Pagination

Both `rescan:` and `kill:` KV list calls now use pagination loops (same pattern as `clearV1Keys`). Without this, entries beyond 1000 keys would be silently dropped.

### Fix 6: Separate KILLS_ENABLED=false Counter

New `variantsKillsPaused` counter. When `KILLS_ENABLED=false`, kills-paused entries increment `result.killsPaused` instead of `result.blocked`. Run summaries now report `variantsKillsPaused` separately. Supabase column `variants_kills_paused` added to `run_summaries`.

Kills-paused entries no longer appear in `dashboardBlocked` (CMs can't action a system flag).

---

## Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | `CampaignResult` interface, `killsPaused` field, `variantsKillsPaused` on `RunSummary` |
| `src/index.ts` | processWithConcurrency signature, callback refactor, tally loop, reEnableSuccess gate, warning dedup, KV pagination, killsPaused separation |
| `src/dashboard.ts` | `e.step` (was `e.step + 1`) |
| `src/supabase.ts` | `variants_kills_paused` in `writeRunSummaryToSupabase` |
| Supabase | `ALTER TABLE run_summaries ADD COLUMN variants_kills_paused integer DEFAULT 0` |

---

## How to Add New Features on Top

1. Add a field to `CampaignResult` in `types.ts`
2. Set it inside the callback (local to `result`, no shared state)
3. Tally it in the sequential loop after `processWithConcurrency` (index.ts, search for `// --- Sequential tally`)
4. If it feeds a run summary field, add to `RunSummary` type + `writeRunSummaryToSupabase` + Supabase column
5. If it feeds the dashboard, push to the appropriate dashboard array in the tally loop

---

## Verification

- `npx tsc --noEmit` passes
- `/cc-review` approved (after fixing 2 issues: Supabase write + indentation)
- Next eval run should show `worker_version = '8a74345'` in run_summaries
- `killsPaused` should be 0 (KILLS_ENABLED=true)
- `variantsBlocked` should only count real last-variant blocks, not kills-paused
