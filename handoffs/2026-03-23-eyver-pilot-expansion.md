# Handoff: Eyver Pilot Expansion (Per-CM Dry Run)

**Deployed:** 2026-03-23 ~evening UTC
**Version:** `a6da7ab`
**Spec:** `specs/cc-eyver-pilot-expansion.md`

## What changed

Eyver added as 5th pilot CM. His campaigns are evaluated and logged to the dashboard, but kills and Slack notifications are suppressed via a new `DRY_RUN_CMS` gate. This lets Sam observe the first purge round before going live.

### Config changes (all in `src/config.ts`)

| Change | Before | After |
|--------|--------|-------|
| PILOT_CMS | ALEX, CARLOS, IDO, SAMUEL | ALEX, CARLOS, EYVER, IDO, SAMUEL |
| CM_MONITOR_CHANNELS | 4 entries | Added EYVER: `C0AN6L2KLLW` (#cc-eyver) |
| automated-applications defaultCm | IDO | EYVER |
| DRY_RUN_CMS (new) | n/a | Set containing EYVER |

### Logic change (`src/index.ts`)

Inside the campaign processing callback, `isDryRun` is shadowed per-campaign:
```ts
const isDryRun = env.DRY_RUN === 'true' || DRY_RUN_CMS.has(cmName ?? '');
```
This means Eyver's campaigns follow the existing dry-run code path (audit logs write, no disableVariant, no Slack) while the other 4 CMs are completely unaffected.

## What did NOT change

- Renaissance 2 `defaultCm: 'EYVER'` was already correct
- Renaissance 5 shared workspace - parser already handles `(EYVER)` tags
- CM_CHANNEL_MAP already had Eyver's general channel (`C0A7B19L932`)
- No parser, evaluator, threshold, safety, or rescan logic changes
- No Supabase schema changes

## Eyver's workspace coverage

| Workspace | Coverage | Mechanism |
|-----------|----------|-----------|
| Automated Applications | All campaigns | `defaultCm: 'EYVER'` |
| Renaissance 2 | All campaigns | `defaultCm: 'EYVER'` |
| Renaissance 5 | Tagged campaigns only | Parser extracts `(EYVER)` from title |

## What to expect on next cron run

- Eyver's campaigns in all 3 workspaces will be evaluated
- Kill candidates logged to Supabase `audit_logs` with `worker_version = 'a6da7ab'`
- Dashboard at cm-dashboard-sable.vercel.app populates Activity Log for Eyver
- Dashboard Action Required populates with any blocked variants or leads issues
- No variants actually killed, no Slack messages sent to #cc-eyver
- Minor noise: dry-run rescan entries will auto-resolve as CM_OVERRIDE (variant never actually disabled). Cleans up in one cycle.

## To go live with kills

One-line change in `src/config.ts`:
```ts
// Before:
export const DRY_RUN_CMS: Set<string> = new Set(['EYVER']);

// After:
export const DRY_RUN_CMS: Set<string> = new Set([]);
```
Commit and redeploy via `./deploy.sh`.

## Verification query

```sql
-- Check Eyver's evaluation results from first run
SELECT campaign, action, variant_label,
  trigger->>'sent' as sent,
  trigger->>'opportunities' as opps,
  trigger->>'threshold' as threshold,
  trigger->>'rule' as rule,
  dry_run
FROM audit_logs
WHERE worker_version = 'a6da7ab'
  AND cm_name = 'EYVER'
ORDER BY timestamp DESC
LIMIT 30;
```
