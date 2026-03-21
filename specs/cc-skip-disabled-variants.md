# CC Revision Spec: Skip Already-Disabled Variants

**Date:** [2026-03-20]
**Severity:** Medium (redundant API calls + noisy audit logs when KILLS_ENABLED=true; no incorrect kills today because kills were paused)
**Scope:** `src/evaluator.ts` (primary fix), `src/index.ts` (defensive BLOCKED path + quick gate)
**CC-Review:** required before deploy

---

## What Went Wrong

During the 6am cron audit on 2026-03-20, the campaign "ON - Pair 1 - PRESIDENTS (SAMUEL) NP" in The Eagles workspace had all 3 variants in step 0 already disabled (toggled off in the Instantly UI). CC evaluated them anyway, returned them as above-threshold (Infinity ratio — 6,138 / 6,102 / 6,102 sent, 0 opportunities), and logged all 3 as BLOCKED across multiple audit entries.

No incorrect disable API calls occurred because `KILLS_ENABLED` was not set to `true` at the time. With kills enabled, CC would have:
1. Identified variants A and B as KILL_CANDIDATE
2. Attempted to disable them via the Instantly API (redundant, already disabled)
3. Blocked variant C as the "last active variant" (also already disabled)
4. Written BLOCKED audit entries on every subsequent cron run (BLOCKED is not deduped at the audit write level)

---

## Why It Went Wrong

### The expected defense exists but may not be firing

`evaluateStep` in `evaluator.ts` already contains a filter at lines 47-58 that is supposed to exclude disabled variants:

```typescript
const activeAnalytics = analytics.filter((a) => {
  if (parseInt(a.step, 10) !== stepIndex) return false;
  const variantIdx = parseInt(a.variant, 10);
  const variant = step.variants[variantIdx];
  if (variant === undefined) { ... return false; }
  return variant.v_disabled !== true;   // <-- should exclude disabled variants
});
```

If this filter worked correctly for the PRESIDENTS campaign, `activeAnalytics` would have been empty, `candidates` would have been empty, and `evaluateStep` would have returned `{ kills: [], blocked: null }` — no BLOCKED entry, no kill attempts.

The fact that BLOCKED was logged for all 3 variants means one of the following is true:

**Root cause A (most likely): `v_disabled` is not set by the Instantly API for manually-disabled variants.** When a CM toggles a variant off in the Instantly UI, the API may return `v_disabled: false`, `v_disabled: undefined`, or omit the field entirely — causing `variant.v_disabled !== true` to pass even though the variant is functionally off. The `v_disabled` field on the `Variant` type is declared as `v_disabled?: boolean`, meaning its absence is a valid state and evaluates as `undefined !== true === true` (i.e., treated as enabled).

**Root cause B (secondary): The analytics rows reference variant indices that don't exist in `step.variants`.** If the campaign detail returns fewer variants in `sequences[0].steps[0].variants` than the analytics rows reference, the `variant === undefined` guard returns `false` (skips), but then the row falls through to... wait, no — the guard returns `false`, which means it's excluded. This path would produce empty candidates, not BLOCKED.

Root cause A is the most consistent explanation for the observed behavior: all 3 analytics rows passed the `v_disabled !== true` check because the field wasn't set, then all 3 hit KILL_CANDIDATE (Infinity ratio), then safetyCheck blocked the last one.

### The secondary issue: BLOCKED is logged unconditionally

The BLOCKED audit write in `index.ts` (~line 808-831) is explicitly marked as unconditional on every run:

```typescript
// ALWAYS write audit entry for blocked variants (every run, not deduped)
```

This is intentional design (BLOCKED should be visible each audit cycle). But it means a campaign with all-disabled variants that still appear enabled in the API will generate BLOCKED noise on every cron run indefinitely.

---

## The Technical Details

### Current code paths that need to change

**`evaluator.ts` line 47-58 — `evaluateStep` active filter:**

The existing `v_disabled !== true` check is the right approach but may be insufficient if the Instantly API uses a different field name or omits the field for manually-disabled variants. The fix should make this check more robust and add explicit logging when a variant is skipped due to disabled state.

**`evaluator.ts` line 26-37 — `safetyCheck` remaining count:**

```typescript
const remaining = step.variants.filter(
  (v, i) => v.v_disabled !== true && !killSet.has(i),
).length;
```

Same `v_disabled !== true` pattern. If the field is unreliable, safetyCheck would count already-disabled variants as "active remaining," producing false LAST_VARIANT blocks. This is what happened: safetyCheck saw 3 "active" variants, confirmed kills on 2, then blocked the 3rd as the last remaining — even though all 3 were already off.

**`index.ts` line 662-663 — `survivingVariantCount` calculation:**

```typescript
const survivingVariantCount = stepDetail.variants.filter(
  (v, i) => v.v_disabled !== true && i !== kill.variantIndex,
).length;
```

Same pattern — would over-count survivors if disabled variants aren't flagged.

**`index.ts` line 661-663 — Redundant API disable call (with KILLS_ENABLED=true):**

When `evaluateStep` returns kill candidates that are already disabled, the kill execution path would call `instantly.disableVariant()` on them. This is a no-op at best, a confusing API error at worst.

---

## What Needs to Be Fixed

### Primary fix: make the disabled-state check reliable in `evaluateStep`

The `evaluateStep` filter needs to handle the case where `v_disabled` is absent or unreliably populated. Two approaches:

**Option 1 (preferred): Add an explicit pre-flight check in `index.ts` before calling `evaluateStep`.**

Before the step loop in `index.ts`, add a check that inspects the stepDetail variants. If ALL variants in a step are disabled, skip the step entirely without calling `evaluateStep`. This is a clean gate that produces a clear log line and never touches the evaluator.

```typescript
// Skip steps where all variants are already disabled
const allVariantsDisabled = stepDetail.variants.every((v) => v.v_disabled === true);
if (allVariantsDisabled) {
  console.log(
    `[auto-turnoff] Step ${stepIndex + 1} of "${campaign.name}" — all variants already disabled, skipping`,
  );
  continue;
}
```

**Option 2: Strengthen the filter in `evaluateStep`.**

Ensure `evaluateStep` skips variants where `v_disabled` is truthy (not just strictly `=== true`). Change:
```typescript
return variant.v_disabled !== true;
```
to:
```typescript
return !variant.v_disabled;
```

This handles `true`, any truthy value, or a field name variant. But it doesn't address root cause A if the field is entirely absent and defaults to `undefined` — `!undefined` is `true` (still treated as enabled). So Option 2 alone is not sufficient if the API omits the field.

**Recommended approach: Both Option 1 AND Option 2 together.**

Option 1 (step-level gate) catches the case where all variants are disabled and prevents noisy BLOCKED logs. Option 2 (truthy check) catches partial cases where some variants are disabled. Both are defensive and cheap.

### Secondary fix: add a pre-check in the kill execution path

Before executing a disable API call for a confirmed kill, verify the variant isn't already disabled:

```typescript
if (stepDetail.variants[kill.variantIndex]?.v_disabled === true) {
  console.log(
    `[auto-turnoff] Skipping disable for ${campaign.name} Step ${stepIndex + 1} Variant ${kill.variantIndex} — already disabled in campaign detail`,
  );
  continue;
}
```

This is a last-resort guard against the root cause A scenario where `evaluateStep` lets through a variant that appears enabled in the API but is actually off.

---

## Changes Required

### 1. `evaluator.ts` — `evaluateStep` filter (line ~47-58)

Change `v_disabled !== true` to `!v.v_disabled` in the `activeAnalytics` filter:

| Location | Current | Change to |
|----------|---------|-----------|
| `evaluateStep` activeAnalytics filter | `return variant.v_disabled !== true` | `return !variant.v_disabled` |

### 2. `evaluator.ts` — `safetyCheck` remaining count (line ~26-28)

Change `v_disabled !== true` to `!v.v_disabled`:

| Location | Current | Change to |
|----------|---------|-----------|
| `safetyCheck` remaining filter | `v.v_disabled !== true` | `!v.v_disabled` |

### 3. `evaluator.ts` — `checkVariantWarnings` disabled check (line ~121)

Same change for consistency:

| Location | Current | Change to |
|----------|---------|-----------|
| `checkVariantWarnings` skip disabled | `step.variants[i].v_disabled === true` | `step.variants[i].v_disabled` (truthy) |

### 4. `index.ts` — All-disabled step gate (line ~636, inside step loop)

Add a continue guard immediately after `stepDetail` is assigned:

```typescript
for (let stepIndex = 0; stepIndex < primaryStepCount; stepIndex++) {
  const stepDetail = campaignDetail.sequences[0].steps[stepIndex];

  // NEW: skip steps where all variants are already disabled
  if (stepDetail.variants.every((v) => v.v_disabled)) {
    console.log(
      `[auto-turnoff] Step ${stepIndex + 1} of "${campaign.name}" — all variants disabled, skipping`,
    );
    continue;
  }

  const stepAnalytics = primaryAnalytics.filter(...
```

### 5. `index.ts` — Pre-kill disabled check (line ~723, before dry-run block)

Add a guard before the kill execution block (both dry-run and live paths):

```typescript
// NEW: defensive check — skip if variant is already disabled in campaign detail
if (stepDetail.variants[kill.variantIndex]?.v_disabled) {
  console.log(
    `[auto-turnoff] Variant ${kill.variantIndex} in step ${stepIndex + 1} of "${campaign.name}" is already disabled — skipping kill`,
  );
  continue;
}
```

This goes in the `for (const kill of kills)` loop, before the dry-run check.

### 6. `index.ts` — `survivingVariantCount` calculation (line ~662)

Change `v_disabled !== true` to `!v.v_disabled` for consistency:

| Location | Current | Change to |
|----------|---------|-----------|
| `survivingVariantCount` filter | `v.v_disabled !== true` | `!v.v_disabled` |

### What NOT to change

- `safetyCheck` function signature — receives `step: Step` as before
- KV dedup keys — unaffected, constructed from `stepIndex` and `variantIndex`
- `AuditEntry` or `RescanEntry` types — no structural changes needed
- `daily_snapshots` disabled_variants count — the snapshot counting loop (~line 541-559) correctly counts `v_disabled === true` variants as disabled. No change needed there. The fix only prevents evaluation and kill attempts for already-disabled variants.
- The unconditional BLOCKED audit write design — remains intentional. The step-level gate (change 4) prevents BLOCKED from being reached for all-disabled steps, so no design change to the BLOCKED write path is needed.

---

## Risk Considerations

### safetyCheck and active variant counting

`safetyCheck` counts how many variants would remain active after killing a set of candidates. The `!v.v_disabled` change ensures already-disabled variants are not counted as "remaining active." This is correct: if 3 variants are in a step and 2 are already disabled, safetyCheck should see 1 active remaining, not 3.

This change makes `safetyCheck` more accurate, not less safe. Previously it over-counted active variants (treating disabled ones as active), which could cause it to confirm kills it shouldn't — or miss LAST_VARIANT blocks because it thought more survivors existed.

### Snapshot counters (daily_snapshots)

The snapshot counting loop (lines 541-559) uses `v_disabled === true` for its counts and is separate from the evaluation loop. It is NOT affected by this change. `disabledVariants` in the snapshot will continue to correctly count all variants that are disabled at the time of the cron run, regardless of whether CC disabled them or the CM did manually.

### KV dedup integrity

No dedup keys are constructed from `AuditEntry` fields. All dedup keys (`kill:`, `blocked:`, `warning:`, `rescan:`) use `stepIndex` and `variantIndex` from loop variables or `RescanEntry.stepIndex` — unaffected.

### No migration needed

No Supabase schema changes. No KV key changes.

---

## Verification

After deploying, confirm with the next cron run:

1. The PRESIDENTS campaign (or any campaign with all-disabled variants) should show a `[auto-turnoff] Step X ... all variants disabled, skipping` log line — not BLOCKED audit entries
2. Query `audit_logs WHERE worker_version = 'v2' AND campaign LIKE '%PRESIDENTS%' AND timestamp > [deploy_time]` — should return 0 rows (no new BLOCKED entries)
3. `safetyCheck` behavior: find a campaign with some disabled and some active variants — confirm only active variants are counted in kill decisions
4. No new Instantly API errors in Cloudflare logs

---

## Change Summary

| File | Changes |
|------|---------|
| `evaluator.ts` | 3 `v_disabled !== true` → `!v.v_disabled` or `v.v_disabled` truthy conversions |
| `index.ts` | 1 all-disabled step gate (inside step loop) + 1 pre-kill disabled guard + 1 `survivingVariantCount` filter change = **3 additions/changes** |
| `types.ts` | None |
| `supabase.ts` | None |
| `slack.ts` | None |

---

## Execution Instructions

1. Use `/technical` persona to implement
2. Run `npx tsc --noEmit` to verify compilation
3. Run `/cc-review` before deploying — all 8 checklist items must pass
4. Deploy with `npx wrangler deploy`
5. Verify with the queries in the Verification section above
