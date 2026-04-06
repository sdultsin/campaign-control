# Handoff: Dedicated Workspace CM Resolution Fix

**Date:** 2026-04-05
**Commit:** 161aaa9
**Worker Version:** 9f295f5f-d85d-4da3-b383-a350a94e71d3
**Spec:** Renaissance/specs/2026-04-05-cc-dedicated-workspace-cm-fix.md

## What Changed

`resolveCmName()` in `src/router.ts` - dedicated workspaces now return `defaultCm` immediately with zero campaign name parsing. Previously, parenthetical text like "(Ben's leads)" was extracted as the CM name, causing campaigns to silently fail the pilot filter.

### Before
1. Parse parentheses from campaign name (any text accepted)
2. Fall back to workspace defaultCm
3. Fall back to suffix parsing

### After
1. If workspace has defaultCm, return it immediately (no parsing)
2. (Shared only) Parse parentheses, validate against known CMs
3. (Shared only) Suffix parsing
4. Warn if unresolved

## Bonus: Shared Workspace Hardening

Shared workspace parenthetical text now validated against `CM_CHANNEL_MAP` keys. Unknown text like "(random text)" falls through to suffix parsing instead of being treated as a CM name.

## What Was Removed

- "No Show" campaign null-return in dedicated workspaces. Warm leads filter (5000 threshold) already covers these.

## Files Changed

- `src/router.ts` - `resolveCmName()` rewritten
- `tests/router.test.ts` - 5 tests covering all paths

## Verify After Deploy

Check next CC audit log for "General (Ben's leads)" campaigns on Outlook 1 - should appear with CM = IDO.
