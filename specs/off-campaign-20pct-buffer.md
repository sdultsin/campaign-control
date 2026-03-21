# Spec: Include OFF Campaigns with 20% Threshold Buffer

**Date:** 2026-03-21
**Status:** Pending build
**Source:** #cc-general discussion + KPI framework 20% buffer recommendation

---

## Summary

Two linked changes shipped as one deploy:

1. **Remove the OFF campaign filter** -- campaigns prefixed with "OFF" are currently excluded from all CC scans. Start evaluating them like any other campaign.
2. **Apply a 20% threshold buffer to OFF campaigns only** -- OFF campaigns get `threshold * 1.2`, giving variants more runway before being killed. Regular campaigns keep their existing raw thresholds.

These are one spec because they are causally linked: including OFF campaigns without the buffer would apply the wrong thresholds, and the buffer has no meaning without including OFF campaigns.

---

## Current Behavior

- `isOffCampaign(name)` regex matches campaign names starting with optional emoji/whitespace followed by `OFF` and a space or hyphen
- Applied as a filter at two points in `index.ts`:
  - Line 486: `const activeCampaigns = allCampaigns.filter((c) => !isOffCampaign(c.name));`
  - Line 501: Defensive re-check inside concurrency worker
- Also filtered in baseline snapshot capture at line 171
- Result: OFF campaigns are completely invisible to the system

## Target Behavior

- OFF campaigns are evaluated normally (same flow as any other campaign)
- Their resolved threshold is multiplied by 1.2 before use
- The buffered threshold applies to everything: sends gate, ratio ceiling, warnings, and rescan entries
- The `isOffCampaign()` function is retained -- used to flag campaigns for threshold buffering instead of exclusion

---

## Implementation

### File: `src/config.ts`

Add named constant after `PRODUCT_THRESHOLDS`:

```typescript
/** 20% buffer applied to OFF-campaign thresholds. OFF campaigns get more runway before kill. */
export const OFF_CAMPAIGN_BUFFER = 1.2;
```

Rationale: Business rule, not a deployment toggle. Named constant next to other threshold constants. Easy to refactor to per-product if needed later.

### File: `src/thresholds.ts`

Modify `resolveThreshold` to accept an `isOff` flag and apply the buffer:

```typescript
import { ..., OFF_CAMPAIGN_BUFFER } from './config';

export async function resolveThreshold(
  workspaceId: string,
  campaign: CampaignDetail,
  api: ThresholdApi,
  kv: KVNamespace,
  isOff: boolean = false,
): Promise<number | null> {
  const config = getWorkspaceConfig(workspaceId);
  if (!config) return null;

  let threshold: number;
  if (config.product === 'FUNDING') {
    threshold = await getInfraThreshold(workspaceId, campaign, api, kv);
  } else {
    threshold = PRODUCT_THRESHOLDS[config.product];
  }

  if (isOff) {
    threshold = Math.round(threshold * OFF_CAMPAIGN_BUFFER);
  }

  return threshold;
}
```

Note: `getInfraThreshold` is unchanged. The buffer multiplies the final resolved value (including averaged mixed-infra thresholds).

### File: `src/index.ts`

Four changes:

**1. Main evaluation loop (line 486):** Remove OFF filter, update logging.

```typescript
// Before:
const activeCampaigns = allCampaigns.filter((c) => !isOffCampaign(c.name));
const skippedOff = allCampaigns.length - activeCampaigns.length;

// After:
const activeCampaigns = allCampaigns;
const offCount = allCampaigns.filter((c) => isOffCampaign(c.name)).length;
```

Update the log line (489-493) to show OFF count instead of skip count:

```typescript
console.log(
  `[auto-turnoff] ${activeCampaigns.length} campaigns` +
    (offCount > 0 ? ` (${offCount} OFF, buffered)` : '') +
    ` in ${workspace.name}`,
);
```

**2. Defensive re-check (line 501):** Remove the early return.

```typescript
// Before:
if (isOffCampaign(campaign.name)) return;

// After:
// (delete this line entirely)
```

**3. Threshold resolution (line 528):** Pass `isOff` flag.

```typescript
// Before:
const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV);

// After:
const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV, isOffCampaign(campaign.name));
```

**4. Baseline snapshot (line 171):** Remove OFF filter.

```typescript
// Before:
const activeCampaigns = campaigns.filter((c) => !isOffCampaign(c.name));

// After:
const activeCampaigns = campaigns;
```

**5. Baseline threshold resolution (line 188):** Pass `isOff` flag.

```typescript
// Before:
const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV);

// After:
const threshold = await resolveThreshold(workspace.id, campaignDetail, instantly, env.KV, isOffCampaign(campaign.name));
```

### File: `src/version.ts`

Auto-updated by `deploy.sh`.

### File: `VERSION_REGISTRY.md`

New row added after deploy with the git hash and notes about OFF campaign inclusion + 20% buffer.

---

## What Does NOT Change

| Component | Why |
|-----------|-----|
| `evaluator.ts` | Pure function -- receives threshold as a number, doesn't care about its source |
| `types.ts` | No type changes needed |
| `slack.ts` | Displays whatever threshold value it receives |
| `supabase.ts` | Writes whatever threshold value it receives |
| `dashboard.ts` | Reads from stored data |
| `leads-monitor.ts` | Independent of kill thresholds |
| `router.ts` | CM routing is name-based, unaffected |
| KV dedup keys | Keyed by campaignId/step/variant, not by threshold value |

---

## Buffered Threshold Values

| Product | Infra | Current | Buffered (OFF) | Cushion |
|---------|-------|---------|----------------|---------|
| Funding | Google | 3,800 | 4,560 | +760 |
| Funding | SMTP/OTD | 4,500 | 5,400 | +900 |
| Funding | Outlook | 5,000 | 6,000 | +1,000 |
| Funding | Default | 4,000 | 4,800 | +800 |
| ERC | All | 6,000 | 7,200 | +1,200 |
| S125 | All | 14,000 | 16,800 | +2,800 |

---

## Downstream Behavior (Verified Correct, No Changes Needed)

### Redemption Window (Rescan)
- `RescanEntry.threshold` stores the threshold used at kill time (line 777/1055)
- Rescan re-evaluates with `entry.threshold` (line 1265)
- Buffered threshold flows through naturally -- OFF campaign variants are rescanned against the same bar that killed them

### Warnings
- `checkVariantWarnings` receives `threshold` as parameter
- OFF campaigns will get warnings at 80% of the buffered threshold (e.g., 80% of 4,560 = 3,648 for Google)
- Correct: more runway before warnings too

### Audit Logs
- Will now include previously-excluded OFF campaigns
- Threshold field shows the buffered value
- Desired behavior for full observability

### Run Summaries / Daily Snapshots
- Campaign and variant counts will increase (OFF campaigns now counted)
- One-time discontinuity in historical tracking, not a bug

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| First-run volume spike | Low | `MAX_KILLS_PER_RUN = 10` cap limits blast radius. Excess candidates logged as DEFERRED, picked up next run. |
| OFF naming edge cases | Low | Regex requires `OFF` followed by space/hyphen (`[\s\-]`). Won't match "OFFER", "OFFLOAD", etc. Case-insensitive. Unchanged from current logic. |
| Mixed-infra + buffer | None | Buffer multiplies the final averaged threshold. E.g., avg(3800,4500) = 4150, buffered = 4980. Correct. |
| Baseline discontinuity | Low | Post-deploy baselines include OFF campaigns. Historical baselines don't. Not actionable, just noted. |
| Gate raised by 20% | Intentional | OFF campaigns need more sends before evaluation. This is the point of the buffer. |

---

## Execution Instructions

1. `/technical` -- implement the changes above
2. `tsc` -- must compile clean
3. `/cc-review` -- iterate until approved
4. `./deploy.sh` -- deploy to Cloudflare Workers
5. Verify: check next cron run logs for OFF campaign evaluation + buffered thresholds
6. Update `VERSION_REGISTRY.md` with new git hash
7. Write handoff doc

---

## Verification Checklist (Post-Deploy)

After next cron run:
- [ ] Console logs show OFF campaigns being evaluated (not skipped)
- [ ] OFF campaign threshold values in audit logs show buffered amounts (e.g., 4560, 5400, 7200)
- [ ] Regular campaign thresholds remain unchanged (3800, 4500, 5000, 6000, 14000)
- [ ] Kill/block/warning notifications fire for OFF campaigns when appropriate
- [ ] Rescan entries for OFF campaign variants store the buffered threshold
- [ ] `worker_version` in Supabase matches the new git hash
- [ ] `VERSION_REGISTRY.md` has the new row
