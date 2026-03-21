# Batch Surviving Variant Count Fix

**Date:** 2026-03-20
**Priority:** MEDIUM (cosmetic/reporting bug, not a safety issue)
**Codebase:** `builds/auto-turn-off/src/`

---

## Problem

When multiple variants in the same step are killed in one run, the "surviving variants" count in the Slack notification is wrong. It computes survival based on the step's state BEFORE any batch kills, not accounting for other kills in the same batch.

### Evidence

**New campaign 4, Step 1** (7pm run):
- 5 variants existed: A, B, C, D, E
- CC killed A, B, C, D in the same run
- After all kills, only E should remain (1 active)
- But the notification for Variant D said: "Step 1 now has only **4** active variant"

From audit_logs (same pattern):
```
B: DISABLED, safety_surviving_variants=2 (should be: depends on batch order)
E: DISABLED, safety_surviving_variants=2 (should be: 1)
```

The count for each kill is computed independently against the pre-batch state, not accounting for other kills happening in the same run.

### Impact

- CMs see incorrect variant counts in notifications — confusing but not dangerous
- The LAST_VARIANT safety check could theoretically be affected if it relies on this same count
  (verify: does the last-variant blocker use the same stale count, or does it re-check?)

---

## Investigation Steps

### Step 1: Find the surviving variant count logic

Read `src/evaluator.ts` — look at `safetyCheck()` and `evaluateStep()`. Find where `safety_surviving_variants` is computed.

Read `src/slack.ts` — find where the "now has only X active variant" message is formatted.

### Step 2: Trace the batch kill flow

Read `src/index.ts` — find the loop that processes kill decisions. Determine:
- Are kills collected first and then executed, or executed one-at-a-time?
- Is there a "kills so far in this step" accumulator passed between iterations?
- Does `safetyCheck()` receive the current kill list or just the step's original state?

### Step 3: Verify LAST_VARIANT safety isn't affected

This is the critical check. The surviving count bug is cosmetic UNLESS it also affects the last-variant protection. Verify:
- Does the LAST_VARIANT check use `safety_surviving_variants` or does it re-count active variants?
- Test scenario: Step has 2 variants (X, Y), both above threshold. Does CC kill both (bad) or kill one and block the other (correct)?

Check Kindred Capital Step 5 from the 7pm run as evidence — CC correctly blocked B after killing C, so last-variant protection may already be working correctly despite the count bug.

### Step 4: Fix

Option A (recommended): Pass a running kill count per step through the evaluation loop. Each subsequent safetyCheck() call subtracts prior kills from the surviving count.

Option B: Two-pass approach — first pass collects all kill candidates, second pass applies them in order with updated counts.

The Slack message should reflect the ACTUAL remaining count after all batch kills, not the pre-batch count.

---

## Execution Instructions

1. `/technical` to load codebase context
2. Read `src/evaluator.ts`, `src/index.ts`, `src/slack.ts`
3. Verify LAST_VARIANT safety first (Step 3 — this is the priority)
4. Implement the count fix
5. `tsc --noEmit`
6. `/cc-review` loop until approved
7. Deploy and verify
8. Write handoff doc

---

## Success Criteria

- [ ] LAST_VARIANT protection confirmed safe (not affected by the count bug)
- [ ] Surviving variant count reflects actual remaining after all batch kills
- [ ] Slack notifications show correct "now has only X active variant" count
- [ ] Audit log `safety_surviving_variants` reflects post-batch count
- [ ] `tsc --noEmit` passes
