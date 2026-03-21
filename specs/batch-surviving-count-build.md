# Build Spec: Batch Surviving Variant Count Fix

**Date:** 2026-03-20
**Priority:** LOW (cosmetic — does not affect safety or kill decisions)
**Codebase:** `builds/auto-turn-off/src/`

---

## Problem

When multiple variants in the same step are killed in one run, the Slack notification says "Step 1 now has only X active variants" with the wrong count. It uses the pre-kill snapshot and only excludes the current kill, not the other kills in the batch.

**Example:** New campaign 4 Step 1 — killed A, B, C, D out of 5 variants. Notification for Variant D said "4 active variants" but only E remains (should say 1).

## Safety confirmation

**LAST_VARIANT protection is NOT affected.** Confirmed by code review and live evidence:

- `safetyCheck()` in `evaluator.ts:24-37` uses a `killSet` containing ALL prospective kills (built cumulatively at `evaluator.ts:80`). It is correct.
- `survivingVariantCount` in `index.ts:680-682` is a SEPARATE calculation used only for Slack messages and audit logs. It does NOT feed back into safety decisions.
- Live proof: Kindred Capital Step 5 correctly blocked Variant B (LAST_VARIANT) after killing C in the same run.

---

## Single file change

**File:** `src/index.ts`
**Location:** Lines 680-682 (inside the `for (const kill of kills)` loop in the batch kill section)

### Current code (line 680-682):

```typescript
const survivingVariantCount = stepDetail.variants.filter(
  (v, i) => !v.v_disabled && i !== kill.variantIndex,
).length;
```

This only excludes the current kill (`i !== kill.variantIndex`). Other kills in the same batch are not excluded.

### Fix:

Add a Set of all kill indices BEFORE the loop begins (~line 661, just before `for (const kill of kills)`):

```typescript
const allKillIndices = new Set(kills.map(k => k.variantIndex));
```

Then replace lines 680-682:

```typescript
const survivingVariantCount = stepDetail.variants.filter(
  (v, i) => !v.v_disabled && !allKillIndices.has(i),
).length;
```

### Total diff: ~3 lines

---

## DO NOT change

- `evaluator.ts` — the `safetyCheck()` logic is correct, do not touch
- `slack.ts` — message formatting is fine, the input data was wrong
- `config.ts` — no config changes
- Any other kill/block/deferred logic

---

## Execution Instructions

1. `/technical` to load codebase
2. Read `src/index.ts` (focus on lines 660-700)
3. Implement the fix (add Set before loop, change filter condition)
4. Run `tsc --noEmit`
5. `/cc-review` loop until approved
6. Deploy: `cd builds/auto-turn-off && ./deploy.sh`
7. After deploy: verify version, add to VERSION_REGISTRY.md
8. Write handoff doc

**Note:** If deploying alongside the send-accuracy-and-kill-cap fix, coordinate — both touch `index.ts`. The changes don't conflict (different code sections) but should be in the same commit to avoid double-deploy.

---

## Verification

After deploy, check the next run's Slack notifications:
- [ ] Any step with multiple kills shows the correct remaining count
- [ ] The `safety_surviving_variants` field in `audit_logs` reflects post-batch count
- [ ] LAST_VARIANT blocking still works (will naturally trigger when a step gets thin)
