# Handoff: Dashboard Variant Dedup Fix

**Date:** 2026-03-24
**Spec:** `specs/cc-dashboard-variant-dedup-fix.md`
**Worker version:** `248cba1`
**Status:** Deployed to production

## What was done

Fixed the bug where 2+ winning variants in the same step overwrote each other in `dashboard_items`, showing the first variant's label with the last variant's numbers.

### 4 changes deployed

1. **Migration** - Dropped and recreated `idx_dashboard_items_dedup` to include `COALESCE(variant, -1)`. Run before worker deploy.

2. **Upsert match** (`supabase.ts:202-206`) - Added variant filter to the existing-item query so each variant gets its own row lookup.

3. **Update clause** (`supabase.ts:221-222`) - Added `variant` and `variant_label` to the update payload so upserts don't silently drop variant identity.

4. **Active + resolve keys** (`dashboard-state.ts:50`, `supabase.ts:264`) - Appended `:${variant ?? 'null'}` to the key format so resolution tracking distinguishes variants within the same step.

### Review

Passed `/cc-review` with all 8 checklist items green. No notification, kill, safety, or snapshot logic was touched.

## Verification

After the next cron run (next scheduled: check `0 10,12,16,22 * * * UTC`), run this query:

```sql
SELECT campaign_name, step, variant, variant_label,
       context->>'sent' as sent, context->>'opportunities' as opps
FROM dashboard_items
WHERE item_type = 'WINNING'
  AND campaign_name = 'Construction 2 - Outlook'
  AND resolved_at IS NULL
ORDER BY step, variant;
```

**Expected:** Two rows for Step 1 (Var A with ~13 opps, Var B with ~9 opps).

## Deployment order executed

1. Migration ran via Supabase MCP `execute_sql` (index dropped + recreated)
2. Worker deployed via `./deploy.sh` -> `248cba1`

## What was NOT changed

- Kill logic, audit logs, Slack notifications, rescan window (all unaffected)
- Dashboard UI (already handles multiple rows per step)
- No new notification types, no KV changes, no dry-run gating changes
