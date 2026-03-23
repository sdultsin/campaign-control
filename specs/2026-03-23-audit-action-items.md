# CC Audit Action Items (Low + Medium)

**Source:** `builds/auto-turn-off/specs/2026-03-23-audit-findings.md`
**Date:** 2026-03-23

---

## Medium Priority (6 items)

### M1: KV lock TOCTOU race condition
**File:** index.ts:52-60
**Risk:** Low (mitigated by CF single-instance cron + stale-trigger + per-kill dedup)
**Fix:** Accept risk OR add random delay + re-read after writing lock. Not urgent.

### M2: No env var validation at startup
**File:** index.ts:412-493
**Fix:** Add a validation block at top of `executeScheduledRun()` checking `INSTANTLY_API_KEYS`, `SLACK_BOT_TOKEN`, `KILLS_ENABLED` before acquiring lock. ~15 lines.

### M3: No API retry/backoff for 429s
**File:** instantly-direct.ts:34-50
**Fix:** Add 1 retry with 2s delay for 429 status codes. Low effort, high resilience gain.

### M4: Revert endpoint uses broken MCP path
**File:** revert.ts:140-142
**Fix:** Update `handleRevert()` to use `InstantlyDirectApi` when `INSTANTLY_MODE=direct`. Mirror the pattern from index.ts. Currently `/__revert?dry_run=false` is non-functional.

### M5: `uncontacted` field name misleading in direct API mode
**File:** index.ts:1552-1554
**Fix:** Rename `leads_uncontacted` to `active_in_sequence` in audit entries. The value is "leads still in sequence," not "never contacted."

### M6: INSTANTLY_API_KEYS parse failure crashes worker
**File:** instantly-direct.ts:14-16
**Fix:** Wrap `JSON.parse(keyMapJson)` in try/catch with descriptive error. 3 lines.

---

## Low Priority (12 items)

### Quick Wins (< 10 lines, zero risk)

| # | Fix | File | Effort |
|---|-----|------|--------|
| 1 | Delete `parser.ts` (unused, 46 lines) | parser.ts | Delete file |
| 2 | Delete `mergeNotification()` (dead code) | evaluator.ts:99-103 | 5 lines |
| 3 | Add `console.warn` for unresolved CM in shared workspaces | router.ts:68 | +1 line |
| 4 | Add `effective_threshold` to warning audit entries | index.ts:1008 | +1 field |
| 5 | Increase `MAX_PERSISTENCE_CHECKS` 20 -> 100 | index.ts:1857 | 1 line |
| 6 | Move `MAX_PERSISTENCE_CHECKS` to config.ts | config.ts + index.ts | 2 lines |

### Other Low Items

- **L2:** 3x `as any` casts (instantly-direct.ts:167, index.ts:667, index.ts:1951) -- define proper Instantly API response types
- **L6:** Supabase client singleton persists across isolates -- negligible, CF restarts on deploy
- **L8:** KV dedup prevents Supabase re-write on failed kill log -- kills that succeeded in Instantly but failed Supabase write won't be retried
- **L9:** Removing a CM from `PILOT_CMS` leaves orphaned dashboard items -- manually resolve via Supabase when removing CMs
- **L11:** Backfill endpoint (`/__backfill`) has no concurrency control -- add chunking (20 at a time) for large backfills
- **L12:** 6 dead `send*Notification()` functions in slack.ts (lines 258-429, ~180 lines) -- delete, keep `format*` functions

---

## Dead Code Summary

| File | What | Lines |
|------|------|-------|
| parser.ts | Entire file unused | 46 |
| evaluator.ts:99-103 | `mergeNotification()` | 5 |
| slack.ts:258-429 | 6x `send*Notification()` functions | ~180 |
| **Total** | | **~231 lines** |

---

## Recommended Order

1. **M6 + M2** (crash prevention) -- env var validation + JSON parse safety
2. **M3** (resilience) -- API retry for 429s
3. **Quick wins 1-6** (dead code + consistency)
4. **M4** (revert endpoint) -- when revert is needed
5. **M5** (field rename) -- when touching leads audit code
6. **M1** (lock race) -- accept or fix opportunistically
