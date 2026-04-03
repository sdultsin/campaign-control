# Handoff: Fix DISABLED/STEP_FROZEN dashboard items incorrectly auto-resolved

**Date:** 2026-04-03
**Files changed:** `src/supabase.ts`, `docs/layer2-knowledge.md`

## What Changed
Added a `PERMANENT_ITEM_TYPES` set (`DISABLED`, `STEP_FROZEN`) to `resolveStaleItems()` in `src/supabase.ts`. The resolve loop now skips items whose `item_type` is in this set. These permanent action records are no longer auto-resolved by subsequent runs.

Also added bug class entry #1b ("Dashboard Resolve Gap") to `docs/layer2-knowledge.md` documenting this as a variant of the original Dashboard Write Gap bug (#1).

## Why
`resolveStaleItems()` resolved ALL dashboard items not found in the current run's active set. But DISABLED items (variant kills) and STEP_FROZEN items are permanent actions - once executed, subsequent runs won't re-detect them (the variant is already disabled in Instantly). Every DISABLED/STEP_FROZEN dashboard item was being resolved by the very next run, typically within 4-10 minutes of creation. Evidence: 4 kills at 13:37-13:40 UTC created dashboard_items at 13:42, resolved at 13:47:58 by the next run.

## How to Verify Post-Deploy
1. Wait for a run that produces kills (or check dry-run CMs like ANDRES/BRENDAN/SHAAN for DISABLED items)
2. After the following run completes, query: `SELECT id, item_type, created_at, resolved_at FROM dashboard_items WHERE item_type = 'DISABLED' AND resolved_at IS NOT NULL AND resolved_at - created_at < interval '1 hour'`
3. No new short-lived DISABLED items should appear after deploy
4. Existing DISABLED items that were incorrectly resolved will need manual re-creation or will naturally repopulate on the next kill cycle
5. Verify transient types (BLOCKED, APPROACHING, WINNING, LEADS_WARNING, LEADS_EXHAUSTED) still auto-resolve correctly when conditions clear

## Risk Assessment
- Very low risk. The change is a single `continue` statement in the resolve loop
- Only affects auto-resolve behavior; upsert/create paths are untouched
- Worst case: if a permanent item type was incorrectly classified, it would persist on the dashboard until manually dismissed (annoying but not harmful)
- No impact on kills, notifications, or any other worker behavior
