# Handoff: Include OFF Campaigns with 20% Threshold Buffer

**Spec:** `specs/off-campaign-20pct-buffer.md`
**Deployed:** 2026-03-21, version `5e18a9b`
**Review:** APPROVED (all 9 checklist items passed, two review passes)

## What the spec asked for

Two linked changes: (1) stop filtering out OFF-prefixed campaigns so they get evaluated like any other campaign, and (2) apply a 20% threshold buffer to OFF campaigns only, giving their variants more runway before being killed.

## What was built

1. **`src/config.ts`** -- Added `OFF_CAMPAIGN_BUFFER = 1.2` constant next to other threshold constants
2. **`src/thresholds.ts`** -- `resolveThreshold()` accepts `isOff` flag, multiplies final threshold by 1.2 when true (after infra averaging for Funding campaigns)
3. **`src/index.ts`** -- Removed OFF filter at 3 points (main eval, defensive re-check, baseline snapshot). Passes `isOffCampaign(campaign.name)` to `resolveThreshold` and `checkVariantWarnings`. Sets `isOff` on all `KillAction` constructions (kill + blocked).
4. **`src/types.ts`** -- Added `isOff: boolean` to `KillAction` and `LastVariantWarning` interfaces
5. **`src/evaluator.ts`** -- `checkVariantWarnings()` accepts and threads `isOff` into warning objects
6. **`src/slack.ts`** -- Kill, last-variant (blocked), and warning notifications append an annotation line for OFF campaigns: "OFF campaign -- threshold raised 20% (base -> buffered)"

## What did NOT change

- `evaluator.ts` kill logic (receives threshold as a number, doesn't care about source)
- `supabase.ts` / KV writes (store whatever threshold value they receive)
- Rescan logic (stores buffered threshold at kill time, re-evaluates against stored value)
- `isOffCampaign()` regex (retained, now used for buffering instead of exclusion)
- Dedup keys, TTLs, error isolation, safety invariants

## Buffered threshold values

| Product | Infra | Normal | OFF (buffered) |
|---------|-------|--------|----------------|
| Funding | Google | 3,800 | 4,560 |
| Funding | SMTP/OTD | 4,500 | 5,400 |
| Funding | Outlook | 5,000 | 6,000 |
| Funding | Default | 4,000 | 4,800 |
| ERC | All | 6,000 | 7,200 |
| S125 | All | 14,000 | 16,800 |

## What to watch

- **First cron run (6pm ET today):** OFF campaigns enter evaluation for the first time. Expect a volume spike in kills/warnings. Kill cap of 10/run limits blast radius; excess candidates log as DEFERRED.
- **Snapshot discontinuity:** Daily snapshot totals will jump (more campaigns counted). One-time step change, not a bug.
- **Infra cache:** `getInfraThreshold` caches the unbuffered value in KV (`infra:{campaignId}`, 7-day TTL). Buffer is applied after cache retrieval, so if a campaign name toggles ON/OFF, the buffer applies dynamically.
- **Slack annotations:** CMs will see "OFF campaign -- threshold raised 20% (3,800 -> 4,560)" on kill/warning notifications. If they're confused, this is the explanation.
