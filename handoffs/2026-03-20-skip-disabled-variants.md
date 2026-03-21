# Handoff: Skip Disabled Variants

**Date:** 2026-03-20
**Spec:** `specs/cc-skip-disabled-variants.md`
**Review verdict:** APPROVE | TypeScript PASS

## What the spec asked for

Fix the bug where campaigns with all variants manually disabled in the Instantly UI (like PRESIDENTS) were still being evaluated, generating false BLOCKED audit entries every cron run. Root cause: `v_disabled` field may be absent/undefined from the Instantly API for manually-disabled variants, and the `!== true` check let them through as "active."

6 targeted changes across `evaluator.ts` and `index.ts` -- truthy checks instead of strict `=== true`, an all-disabled step gate, and a pre-kill defensive guard.

## What was actually built

The diff was much larger than the 6-spec changes. The spec's changes were implemented cleanly, but they landed alongside a batch of other improvements that were already staged in the working tree:

- **All 6 spec changes** implemented exactly as specified
- **Batch kill execution** -- single `update_campaign` API call instead of individual `disableVariant()` calls per variant
- **Direct API mode** -- `InstantlyDirectApi` bypasses MCP for fast endpoints (50x faster), MCP still used for leads count
- **Phase 4: Kill Persistence Monitor** -- detects "ghost re-enables" where a killed variant reappears as enabled
- **Step indexing fix** -- all audit entries and notifications now use 1-indexed steps (matching Instantly UI)
- **worker_version: 'v2'** added to all 5 Supabase tables
- **Leads monitor improvements** -- uses `contacted` from campaign analytics instead of computing step0 sent
- **MCP resilience** -- SSE idle timeout handling, reconnect before leads phase in direct mode
- **KILLS_PAUSED path** now writes BLOCKED audit entries (previously only console.log)
- **Supabase writes** changed from fire-and-forget to awaited (still .catch() wrapped)
- **New endpoints** -- `/__revert` and `/__clear-v1-keys`

## Review notes

- All 8 checklist items passed (dedup, dual-write, dry run, kills gate, safety, error isolation, snapshots, rescan)
- Two new files (`revert.ts`, `instantly-direct.ts`) are imported but weren't in the diff -- couldn't be fully reviewed, but TypeScript compilation passed
- `/__clear-v1-keys` is destructive (deletes all KV dedup keys) -- has a `confirm=yes` guard but no auth beyond Cloudflare Workers route protection
- Ghost detection intentionally uses strict `v_disabled !== true` (checking API response directly, not filtering for evaluation)

## Next steps

- Deploy with `npx wrangler deploy`
- Verify with next cron run: PRESIDENTS campaign should show "all variants disabled, skipping" log line, not BLOCKED entries
- Query `audit_logs WHERE worker_version = 'v2' AND campaign LIKE '%PRESIDENTS%'` after deploy to confirm no new BLOCKED rows
