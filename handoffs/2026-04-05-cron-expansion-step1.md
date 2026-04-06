# Cron Expansion Step 1: 8 Evals/Day

**Date:** 2026-04-05
**Worker version:** `3c2d885`
**Status:** DEPLOYED

## What changed

Increased CC evaluation frequency from 4 full evals/day to 8, filling gaps in the existing schedule. Self-audit gated to 1x/day to avoid noise.

## Changes

| File | Change |
|------|--------|
| `wrangler.toml:7` | Cron: `0 10,12,13,14,16,18,19,21,23 * * *` (was `0 10,12,16,19,23`) |
| `src/config.ts:210` | `CRON_HOURS_UTC` = `[10, 13, 14, 16, 18, 19, 21, 23]` (was `[10, 16, 19, 23]`) |
| `src/index.ts:362-366` | `skipAudit = scheduledHour !== 23` passed to `executeScheduledRun` |

## Schedule (UTC)

| UTC | ET | Type |
|-----|-----|------|
| 10:00 | 6am | Full eval |
| 12:00 | 8am | Digest only |
| 13:00 | 9am | Full eval |
| 14:00 | 10am | Full eval |
| 16:00 | 12pm | Full eval |
| 18:00 | 2pm | Full eval |
| 19:00 | 3pm | Full eval |
| 21:00 | 5pm | Full eval |
| 23:00 | 7pm | Full eval + self-audit |

## What did NOT change

- Kill logic, thresholds, safety checks
- Dedup TTLs (all safe at 2x volume)
- Lock timeout (20 min vs 60 min minimum gap)
- Concurrency cap (5)
- Kill budget per CM: 10/run (now 80/day max vs 40/day)
- Queue consumer (on-demand triggers still run full audit)

## Monitor (first 48 hours)

1. **Run duration** - Check `run_summaries` for `duration_ms`. Flag if any run > 13 min.
2. **Instantly 429s** - Grep worker logs for "429" or "rate_limit".
3. **Kill volume** - Check `audit_logs` daily count. Should not spike dramatically.
4. **Self-audit** - Verify only 1 `audit_results` row per day (23:00 UTC run).

## Step 2 criteria

After 1 week with no issues (no 429s, no timeouts > 14 min), switch to true hourly: `crons = ["0 10-23 * * *"]`.
