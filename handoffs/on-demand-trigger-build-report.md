# On-Demand Queue Trigger - Build Report

**Spec:** `specs/cc-on-demand-trigger.md`
**Date:** 2026-03-25
**Version:** `9540460`
**Status:** DEPLOYED, pending verification

## What Was Built

Exactly what the spec described — 3 files, ~25 lines:

| File | Change |
|------|--------|
| `wrangler.toml` | `[[queues.producers]]` + `[[queues.consumers]]` for `cc-on-demand` (max_batch_size=1, max_retries=0) |
| `src/types.ts` | `ON_DEMAND_QUEUE: Queue` added to Env interface |
| `src/index.ts` | `/__trigger` (202), `/__scheduled` deprecated (410), `queue()` handler calling `executeScheduledRun(env)` |

## CC Review

**APPROVED** on first pass. 9/9 checklist items verified. No regression on any known bug class.

One behavioral note from review: the old `/__scheduled` passed `{ skipAudit: true }`. The new queue handler calls `executeScheduledRun(env)` without that flag — on-demand triggers now run the full pipeline including Phase 7 self-audit. This is the correct behavior (matches cron handler).

## Spec Corrections

**Queue auto-creation is wrong.** The spec stated: "Wrangler creates it automatically on `wrangler deploy` when it sees the `[[queues.producers]]` config. No manual step needed."

This is false. Wrangler requires `wrangler queues create cc-on-demand` before the first deploy. The deploy failed with: `Queue "cc-on-demand" does not exist.` Fixed by running the create command first.

## Deploy Sequence

1. cc-builder agent implemented 3-file change, tsc passed
2. cc-reviewer agent approved (9/9 checklist)
3. `git commit` → `deploy.sh` → **failed** (queue doesn't exist)
4. `wrangler queues create cc-on-demand` → redeploy → **succeeded**
5. `git push` rejected (remote had 3 new commits from other session)
6. `git pull --rebase` → 3 conflicts resolved:
   - `index.ts`: remote `1c0f6de` changed `/__scheduled` to full pipeline — we kept 410 deprecation
   - `version.ts`: trivial conflict, kept remote version (deploy.sh re-stamps)
   - `VERSION_REGISTRY.md`: kept both entries (remote's `93913f9` + our `782c0c8`)
7. Redeployed from rebased code → version `9540460` → push succeeded

## Verification Checklist (from spec)

All pending — Sam to execute:

- [ ] `curl -X POST https://auto-turnoff.sdultsin.workers.dev/__trigger` → expect HTTP 202
- [ ] Watch worker logs (`wrangler tail`) → expect `on_demand_trigger` event + normal `run_start`
- [ ] Check #cc-admin → expect full self-audit digest (Phase 7)
- [ ] Check `run_summaries` in Supabase → expect new row with full data
- [ ] `curl https://auto-turnoff.sdultsin.workers.dev/__scheduled` → expect HTTP 410
- [ ] Next 3 cron runs should be normal (no false FAILED verdicts)

## Risk

Low. Queue handler calls exact same `executeScheduledRun()` as cron. Only net-new code is the queue plumbing. If queue binding fails, `/__trigger` returns 500 — clean failure, no partial state.
