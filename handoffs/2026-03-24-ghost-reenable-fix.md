# Handoff: Ghost Re-Enable Fix

**Version:** `d7a5055`
**Deployed:** 2026-03-24 ~18:00 UTC
**Spec:** [specs/2026-03-24-ghost-reenable-fix.md](../../specs/2026-03-24-ghost-reenable-fix.md)
**Investigation:** [deliverables/cc-ghost-investigation-2026-03-24.md](../../deliverables/cc-ghost-investigation-2026-03-24.md)

## What shipped

### 1. Verbose ghost audit logging (was silently failing)
- `.catch(() => {})` on GHOST_REENABLE KV and Supabase writes replaced with `.catch((err) => console.error(...))`
- Next run with ghosts will surface the actual error in worker logs
- Root cause of Supabase write failure is still unknown -- this deploy is the diagnostic step

### 2. ghost_details JSONB on run_summaries
- DB migration applied: `ALTER TABLE run_summaries ADD COLUMN ghost_details JSONB DEFAULT NULL`
- When ghosts are detected, full details (workspace, campaign, step, variant, CM, kill date, detection date) are stored in the run summary
- Query: `SELECT ghost_details FROM run_summaries WHERE ghost_re_enables > 0 ORDER BY timestamp DESC`

### 3. Ghost exemption (do not re-kill)
- When Phase 4 detects a ghost, it writes `exempt:<campaignId>:<stepIndex>:<variantIndex>` to KV (90-day TTL)
- Phase 2 kill execution checks for the exempt key alongside the existing kill dedup check
- Exempt variants are logged and skipped -- they don't count against the kill budget
- After 90 days the exemption expires and the variant re-enters normal evaluation

### 4. Ghost Slack notification
- Sends to the CM's monitor channel: `:ghost: Ghost re-enable detected: *[Campaign]* Step X Variant Y was killed on [date] but has been re-enabled. CC will not re-disable this variant.`
- Deduped via `ghost-notified:<campaignId>:<step>:<variant>` (90-day TTL)
- Fires regardless of DRY_RUN and KILLS_ENABLED (informational only)
- Falls back to console.warn if no CM channel mapping exists

## New KV key prefixes
| Prefix | Purpose | TTL |
|--------|---------|-----|
| `exempt:` | Prevents re-kill of CM-re-enabled variants | 90 days |
| `ghost-notified:` | Slack notification dedup | 90 days |

## What to verify on next run
1. **If ghosts are detected:** Check worker logs for the actual Supabase audit write error (the diagnostic from Change 1)
2. **ghost_details populated:** `SELECT ghost_details FROM run_summaries WHERE worker_version = 'd7a5055' AND ghost_re_enables > 0`
3. **Exempt keys written:** If ghosts fire, verify the exempt key exists: check Phase 2 logs for `[auto-turnoff] Exempt:` messages on subsequent runs
4. **Slack notification:** Verify ghost message appears in the CM's channel (most likely Outlook 1 / Ido's channel based on the investigation)

## Pending action
- **Ask pilot CMs** whether the "don't re-kill" default is right: post in #cc-alex, #cc-carlos, #cc-eyver, #cc-ido, #cc-lautaro, #cc-samuel
- The 3 ghosts from today's investigation (all Outlook 1) had their kill keys deleted by the c90bbb5 run -- they won't be re-detected as ghosts. But if anyone re-enables another killed variant going forward, the full pipeline (detect -> exempt -> notify) will fire.

## Files changed
- `src/config.ts` -- EXEMPT_TTL_SECONDS, GHOST_NOTIFIED_TTL_SECONDS
- `src/types.ts` -- GhostDetail interface, ghostDetails on RunSummary
- `src/index.ts` -- Phase 2 exempt check (~line 897), Phase 4 ghost details + exempt write + Slack notification
- `src/supabase.ts` -- ghost_details in run_summaries insert
