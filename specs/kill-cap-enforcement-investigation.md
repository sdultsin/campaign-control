# Kill Cap Enforcement Investigation

**Date:** 2026-03-20
**Priority:** HIGH
**Codebase:** `builds/auto-turn-off/src/`

---

## Problem

Ido received 15 auto-kills in the 7pm run. The system is supposed to have a kill cap of 10 per run. Either the cap isn't enforced, the cap is per-something-else (per-CM, per-workspace, per-campaign), or it was changed/removed.

### Evidence

Query the audit logs for kills in the 7pm run:

```sql
SELECT cm, COUNT(*) as kill_count
FROM audit_logs
WHERE action = 'DISABLED'
  AND dry_run = false
  AND timestamp >= '2026-03-20 23:00:00+00'
  AND timestamp <= '2026-03-20 23:02:00+00'
GROUP BY cm;
```

Expected: Ido has 15 DISABLED entries. No other CMs have kills in this window.

---

## Investigation Steps

### Step 1: Find the kill cap logic

Read `src/index.ts` and `src/evaluator.ts`. Search for:
- `kill_cap`, `killCap`, `KILL_CAP`, `MAX_KILLS`, `max_kills`
- Any counter that tracks kills per run
- Any logic that breaks out of evaluation loops early

Also read `src/config.ts` for any cap constants.

### Step 2: Determine the cap scope

If a cap exists, determine:
- Is it per-run (global across all CMs)?
- Is it per-CM per-run?
- Is it per-workspace per-run?
- Is it per-campaign?

### Step 3: Check if the cap was exceeded or doesn't exist

Cross-reference the code with the audit logs. If the cap is 10 per run:
- Were all 15 kills from the same run execution?
- Could the cron have fired twice (overlapping runs)?
- Was there a dry-run + live run in the same window?

Check `run_summaries` table for the 7pm run:
```sql
SELECT * FROM run_summaries
WHERE timestamp >= '2026-03-20 22:50:00+00'
ORDER BY timestamp DESC;
```

### Step 4: Fix if needed

If the cap isn't enforced:
- Add a kill counter that increments per DISABLED action
- Once cap is reached, log remaining kill-worthy variants as CAPPED (not BLOCKED)
- Send a Slack notification: "Kill cap reached (10/10). X additional variants exceeded threshold but were deferred to next run."
- Deferred variants should be re-evaluated next run (not dedup-suppressed)

If the cap scope is wrong (e.g., per-campaign but should be per-run):
- Adjust scope to per-run across all CMs

---

## Execution Instructions

1. `/technical` to load codebase context
2. Read `src/index.ts`, `src/evaluator.ts`, `src/config.ts`
3. Run the SQL queries above against CC Supabase (project `kczjvbbpwjrgbvomdawi`)
4. Identify the issue and implement fix
5. `tsc --noEmit`
6. `/cc-review` loop until approved
7. Deploy and verify
8. Write handoff doc

---

## Success Criteria

- [ ] Kill cap scope and value documented
- [ ] If cap was exceeded, root cause identified
- [ ] Cap enforcement verified in code (with tests or dry-run confirmation)
- [ ] CAPPED variants get a distinct notification so CMs know more kills are pending
- [ ] `tsc --noEmit` passes
