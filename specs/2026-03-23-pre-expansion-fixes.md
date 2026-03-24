# CC Pre-Expansion Fixes

**Date:** 2026-03-23
**Context:** Sam is adding positive-signal features (boost notifications, dashboard expansion). These fixes must land BEFORE building on top of the existing code.
**Base version:** `c071c09` (post-audit-action-items)

---

## Why Now

The `processWithConcurrency` callback at index.ts:582-1215 is a 633-line closure that mutates ~25 shared variables. Every new counter, dashboard item type, or notification you add inside this callback inherits the same concurrency bugs. Fix the foundation first, then build.

---

## Fix 1: Refactor processWithConcurrency to Return-Value Pattern

**Priority:** CRITICAL (blocks all new feature work)
**Files:** index.ts:94-107 (function), index.ts:582-1215 (callback), types.ts
**Findings:** v2-HIGH-1, v2-HIGH-3, v1-HIGH-1, v2-LOW-6

### Problem

`processWithConcurrency` runs up to 15 concurrent workers draining a shared queue. The callback mutates 25+ shared variables via `++`, `--`, `+=`, `.push()`, and object property writes. JavaScript `++` is not atomic across `await` boundaries — between read and write, another worker can execute, causing lost increments.

Affected shared state:
```
Counters (12):
  totalCampaignsEvaluated, totalVariantsKilled, totalVariantsBlocked,
  totalVariantsWarned, totalVariantsDeferred, killBudgetRemaining,
  totalErrors, workspaceKills, workspaceErrors,
  totalLeadsChecked, totalLeadsWarnings, totalLeadsExhausted

Arrays (5):
  leadsCheckCandidates, dashboardBlocked, dashboardDryRunKills,
  dashboardLeadsExhausted, dashboardLeadsWarnings

Accumulator object (snapshotAcc):
  .totalCampaigns, .totalSteps, .totalVariants, .activeVariants,
  .disabledVariants, .aboveThreshold, .byWorkspace[id].*, .byCm[key].*,
  .campaignHealth[]
```

### Fix

**Step 1:** Define a `CampaignResult` interface in types.ts:

```typescript
interface CampaignResult {
  evaluated: boolean;              // false if skipped (non-pilot)
  kills: { kill: KillAction; auditEntry: AuditEntry; stepIndex: number; channelId: string }[];
  blocked: AuditEntry[];
  dryRunKills: AuditEntry[];
  warnings: number;
  deferred: number;
  errors: number;
  leadsCandidate: LeadsCheckCandidate | null;
  snapshot: {
    totalVariants: number;
    activeVariants: number;
    disabledVariants: number;
    aboveThreshold: number;
    steps: number;
    health: CampaignHealthEntry;
  } | null;
}
```

**Step 2:** Change `processWithConcurrency` signature to return results:

```typescript
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        const result = await fn(item);
        results.push(result);  // Array.push is safe — single-threaded JS
      }
    }
  });
  await Promise.all(workers);
  return results;
}
```

Note: `Array.push` is safe in single-threaded JS because it's synchronous — no `await` between read and write. The `++` operators are the problem because they occur before `await` calls that yield to other workers.

**Step 3:** Refactor the callback to build and return a `CampaignResult` instead of mutating shared state. The callback should NOT touch any variable defined outside its scope. All notification collection, kill execution, and audit writes still happen inside the callback (they're per-campaign operations). Only the COUNTING moves out.

**Step 4:** After `processWithConcurrency` completes, tally results sequentially:

```typescript
const results = await processWithConcurrency(activeCampaigns, concurrencyCap, async (campaign) => {
  // ... evaluate campaign, execute kills, collect notifications ...
  return result;  // CampaignResult
});

// Sequential tally — no concurrency, no races
for (const r of results) {
  if (!r.evaluated) continue;
  totalCampaignsEvaluated++;
  totalVariantsKilled += r.kills.length;
  totalVariantsBlocked += r.blocked.length;
  totalVariantsWarned += r.warnings;
  totalVariantsDeferred += r.deferred;
  totalErrors += r.errors;
  dashboardBlocked.push(...r.blocked);
  dashboardDryRunKills.push(...r.dryRunKills);
  if (r.leadsCandidate) leadsCheckCandidates.push(r.leadsCandidate);
  if (r.snapshot) {
    // Accumulate snapshot fields...
  }
}
```

**Step 5:** killBudgetRemaining needs special handling. Options:
- **(Recommended) Two-pass approach:** In the callback, evaluate and return kill *candidates* without executing. After `processWithConcurrency`, sort candidates by priority, apply kill budget sequentially, then execute the approved kills (can re-parallelize execution since it's write-only, no shared counters).
- **(Simpler, less optimal)** Keep killBudgetRemaining shared but accept the race. Current impact: up to concurrencyCap-1 extra kills per run (19 vs 10). With the refactor eliminating all OTHER races, this is the only remaining shared mutable variable.

Pick the simpler option if the two-pass approach feels like over-engineering for now. The kill cap race is bounded and self-correcting (deferred variants retry next run).

### Verification

After refactoring:
- `npx tsc --noEmit` passes
- Zero shared mutable state inside the callback (grep for variables defined at lines 465-507)
- Run summary counts should be identical for concurrency=1 vs concurrency=10 (can verify by temporarily setting CONCURRENCY_CAP=1 and comparing run_summaries)

---

## Fix 2: Gate RE_ENABLED Audit on enableVariant Success

**Priority:** HIGH (false audit trail)
**File:** index.ts:1471-1502
**Finding:** v2-HIGH-2

### Problem

The `RE_ENABLED` audit entry at line 1471 runs unconditionally after the re-enable attempt. When `enableVariant()` returns false (line 1464), the variant is NOT re-enabled, but a `RE_ENABLED` audit entry is written to KV and Supabase anyway.

### Fix

Add a `reEnableSuccess` boolean flag. Set it in both branches:

```typescript
let reEnableSuccess = false;

if (isDryRun) {
  // ... existing dry-run path ...
  reEnableSuccess = true;  // dry-run "success"
} else {
  const success = await instantly.enableVariant(...);
  if (success) {
    reEnableSuccess = true;
    // ... existing success path ...
  } else {
    // ... existing failure path ...
  }
}

// Only write audit if re-enable succeeded (or dry-run)
if (reEnableSuccess) {
  const reEnableAudit: AuditEntry = { ... };
  await writeAuditLog(env.KV, reEnableAudit).catch(...);
  if (sb) await writeAuditLogToSupabase(sb, reEnableAudit).catch(...);
}
```

~5 lines changed. Zero risk.

---

## Fix 3: Write Warning Dedup Key in Dry-Run Mode

**Priority:** MEDIUM (noisy audit data)
**File:** index.ts:1059-1078
**Finding:** v2-LOW-4

### Problem

The warning dedup key (`env.KV.put(dedupKey, '1', ...)`) at line 1077 is inside the `else` (non-dry-run) branch. In dry-run mode, every run re-logs warnings for the same variants — 3x per day, 9 warnings per variant per day instead of 1. Pollutes audit_logs and inflates `variantsWarned` in run summaries.

### Fix

Move the `env.KV.put(dedupKey, ...)` call BEFORE the `if (isDryRun)` branch, or duplicate it inside the dry-run branch. The dedup key prevents re-alerting — it should apply regardless of dry-run mode.

```typescript
// Write dedup key in all modes (prevents re-alerting)
await env.KV.put(dedupKey, '1', { expirationTtl: WARNING_DEDUP_TTL_SECONDS });

if (isDryRun) {
  console.log(`[DRY RUN] WARNING: ...`);
} else {
  collector.add(channelId, 'WARNING', ...);
}
```

1 line moved. Zero risk.

---

## Fix 4: Dashboard Step Off-by-One

**Priority:** MEDIUM (wrong data in KV dashboard)
**File:** dashboard.ts:161
**Finding:** v2-LOW-3

### Problem

Dashboard HTML renders `e.step + 1` but audit entries already store 1-indexed steps (written as `step: stepIndex + 1` throughout index.ts). The KV dashboard (`/__dashboard`) displays step 1 as "2", step 2 as "3", etc.

### Fix

Change `${e.step + 1}` to `${e.step}` at dashboard.ts:161.

1 character change.

---

## Fix 5: Rescan KV List Pagination

**Priority:** MEDIUM (will break at scale)
**File:** index.ts:1244
**Finding:** v2-MEDIUM-6

### Problem

`env.KV.list({ prefix: 'rescan:' })` returns max 1000 keys. At current scale (~30 rescan entries), this is fine. At full fleet with heavy kill activity, entries could exceed 1000. Same issue exists in Phase 4 persistence monitor.

### Fix

Add pagination loop. The pattern already exists in the codebase at the `clearV1Keys` function (index.ts:120-137):

```typescript
let rescanCursor: string | undefined;
let allRescanKeys: KVNamespaceListKey<unknown>[] = [];
do {
  const page = await env.KV.list({ prefix: 'rescan:', cursor: rescanCursor });
  allRescanKeys.push(...page.keys);
  rescanCursor = page.list_complete ? undefined : page.cursor;
} while (rescanCursor);
```

Then iterate over `allRescanKeys` instead of `rescanKeys.keys`.

Apply the same pattern to Phase 4 persistence monitor's KV list call.

---

## Fix 6: Separate KILLS_ENABLED=false Counter from Blocked

**Priority:** LOW (misleading run summary)
**File:** index.ts:1087-1109
**Finding:** v2-MEDIUM-2

### Problem

When `KILLS_ENABLED=false`, pending kills are written as `BLOCKED` audit entries and `totalVariantsBlocked++` is incremented at line 1105. This conflates "last variant, can't kill" (real blocked) with "kill suppressed by feature flag" (paused). Run summary `variantsBlocked` is inflated.

### Fix

Add `totalVariantsKillsPaused` counter. When KILLS_ENABLED=false, increment `totalVariantsKillsPaused` instead of `totalVariantsBlocked`. Write it to the run summary as `variantsKillsPaused`.

If you do Fix 1 first, this becomes a field on `CampaignResult` — no shared state concern.

---

## Not Included (Can Wait)

These were found in the v2 audit but are not blocking new feature work:

| Finding | Why It Can Wait |
|---------|----------------|
| MEDIUM-1: Stale campaignDetail | Theoretical — Instantly campaigns have independent steps |
| MEDIUM-4: Dashboard upsert key lacks variant | Requires DB migration, not blocking for positive signals |
| MEDIUM-5: Leads contacted formula inconsistency | No functional impact on alerts |
| MEDIUM-7: OFF regex false negatives | Edge case, can broaden later |
| MEDIUM-3: isDryRun shadowing | Only matters when Slack notifications re-enabled — flag it then |
| LOW-1 through LOW-9 (remaining) | Cleanup items, no functional risk |

---

## Execution Instructions

1. Start with Fix 1 (concurrency refactor) — this is the big one, ~200 lines touched
2. After Fix 1, Fixes 2-6 are small and independent — can be done in any order
3. Run `cd builds/auto-turn-off && npx tsc --noEmit` after each fix
4. Commit after Fix 1, then batch Fixes 2-6 into one commit
5. Do NOT deploy — Sam deploys after review
6. Run `/cc-review` against the diff before declaring done
