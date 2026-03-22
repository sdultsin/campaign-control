# Handoff: Graduated Threshold (Zero-Opp Runway Extension)

**Deployed:** 2026-03-22 ~22:30 UTC
**Version:** `0def5ae`
**Spec:** `specs/cc-graduated-threshold.md`

## What changed

Variants with opportunities > 0 now get a 10% extended threshold before being killed. The kill comparison for these variants uses `threshold * 1.1` instead of the base threshold.

- **Zero-opp variants:** Unchanged. `sent >= threshold && opps === 0` = kill.
- **Variants with opps:** Ratio compared against `threshold * 1.1`. A variant at 4,100:1 against a 3,800 threshold (effective 4,180) now survives.
- **OFF campaign stacking:** OFF buffer (1.2) applied first in `resolveThreshold`, then 1.1x in `evaluateVariant`. Net: base * 1.32.

## Files changed

| File | Change |
|------|--------|
| `src/config.ts` | Added `OPP_RUNWAY_MULTIPLIER = 1.1` |
| `src/evaluator.ts` | `evaluateVariant()` applies multiplier for opps > 0 ratio comparison |
| `src/types.ts` | Added optional `effective_threshold` to AuditEntry trigger type |
| `src/index.ts` | Kill + blocked paths compute and record `effective_threshold` in audit entries |
| `src/dashboard-state.ts` | BLOCKED context passes `effective_threshold` to dashboard JSONB |

## What did NOT change

- Minimum-sends gate (`sent < threshold`) still uses base threshold
- `resolveThreshold()` in thresholds.ts untouched
- `checkVariantWarnings()` still warns at 80% of base threshold
- `safetyCheck()` untouched
- No Supabase schema migration needed (all data in existing JSONB columns)

## Verification

Next eval run (10pm ET / 02:00 UTC):
1. Check audit_logs for a variant with `opportunities > 0` -- `trigger.effective_threshold` should be ~10% above `trigger.threshold`
2. Check a zero-opp variant -- `trigger.effective_threshold` should equal `trigger.threshold`
3. Check an OFF campaign variant with opps -- effective should be base * 1.32

```sql
-- Find variants with the new effective_threshold field
SELECT campaign, variant_label,
  trigger->>'sent' as sent,
  trigger->>'opportunities' as opps,
  trigger->>'threshold' as base_threshold,
  trigger->>'effective_threshold' as effective_threshold,
  trigger->>'rule' as rule
FROM audit_logs
WHERE worker_version = '0def5ae'
ORDER BY timestamp DESC
LIMIT 20;
```
