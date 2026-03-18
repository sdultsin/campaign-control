# Thresholds: Per-Infrastructure and Product-Specific

**Spec version:** v2-v3
**Features covered:** 2.1 (per-infrastructure thresholds), 3.2 (product-specific thresholds)
**Status:** Draft

---

## Background

v1 uses a single flat threshold of 4,000:1 (sent-to-opportunity) for every campaign. This value doubles as both the minimum sends gate (skip evaluation until this many sends) and the kill ceiling (opportunity rate worse than this kills the variant). The v1 evaluator:

```typescript
export function evaluateVariant(sent: number, opportunities: number, threshold: number): Decision {
  if (sent < threshold) return SKIP;
  if (opportunities === 0) return KILL_CANDIDATE;
  if (sent / opportunities > threshold) return KILL_CANDIDATE;
  return KEEP;
}
```

The function signature already accepts a `threshold` parameter. v2 and v3 do not change this function — they change how the threshold value is resolved before being passed in.

---

## 1. Per-Infrastructure Thresholds (Feature 2.1)

Different email providers have different deliverability characteristics. Google inboxes are warmer and reply rates are higher, so a tighter threshold is justified. Outlook and SMTP/OTD are colder — the same ratio ceiling would over-kill healthy campaigns.

### 1.1 Provider Threshold Map

Define in `config.ts`:

```typescript
export const PROVIDER_THRESHOLDS: Record<number, number> = {
  1: 4500,  // SMTP / OTD
  2: 3800,  // Google
  3: 5000,  // Outlook
};

export const DEFAULT_THRESHOLD = 4000;
```

Provider codes match the `provider_code` field on Instantly account objects:
- `1` = SMTP / OTD
- `2` = Google Workspace
- `3` = Outlook / Microsoft 365

These values are final. No 20% buffer has been applied.

### 1.2 Infrastructure Detection Chain

Resolving provider from campaign to threshold requires three hops:

```
campaign.email_tag_list (UUID[])
  -> list_accounts(tag_ids=UUID)   [Instantly MCP call]
  -> account.provider_code (number)
  -> PROVIDER_THRESHOLDS[provider_code]
```

**Step by step:**

1. Read `campaign.email_tag_list` — an array of tag UUIDs assigned to the campaign.
2. For each tag UUID, call `list_accounts(tag_ids=UUID)` to retrieve the accounts in that sending pool.
3. Collect the unique `provider_code` values across all returned accounts.
4. Look up the threshold for each provider code.
5. If all accounts share the same provider (expected, see section 1.4): use that provider's threshold directly.
6. If mixed providers are found: apply averaging logic (section 1.4).

### 1.3 New Function: `getInfraThreshold`

Add to `infrastructure.ts` (new file):

```typescript
import { PROVIDER_THRESHOLDS, DEFAULT_THRESHOLD } from './config';
import { KVNamespace } from '@cloudflare/workers-types';

export async function getInfraThreshold(
  campaign: Campaign,
  mcp: InstantlyMCP,
  kv: KVNamespace
): Promise<number> {
  const campaignId = campaign.id;
  const cacheKey = `infra:${campaignId}`;

  // Check KV cache first
  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    return parseInt(cached, 10);
  }

  // Resolve from tag list
  const tagList = campaign.email_tag_list ?? [];
  if (tagList.length === 0) {
    console.warn(`[auto-turnoff] Campaign ${campaign.name} has no email_tag_list. Using default threshold.`);
    return DEFAULT_THRESHOLD;
  }

  const providerCodes = new Set<number>();
  for (const tagId of tagList) {
    const accounts = await mcp.list_accounts({ tag_ids: tagId });
    for (const account of accounts) {
      if (account.provider_code !== undefined) {
        providerCodes.add(account.provider_code);
      }
    }
  }

  if (providerCodes.size === 0) {
    console.warn(`[auto-turnoff] No provider_code found for campaign ${campaign.name}. Using default threshold.`);
    return DEFAULT_THRESHOLD;
  }

  const threshold = resolveThreshold(providerCodes, campaign.name);

  // Cache for 7 days — infrastructure does not change
  await kv.put(cacheKey, String(threshold), { expirationTtl: 604800 });

  return threshold;
}

function resolveThreshold(providerCodes: Set<number>, campaignName: string): number {
  const codes = Array.from(providerCodes);

  if (codes.length === 1) {
    return PROVIDER_THRESHOLDS[codes[0]] ?? DEFAULT_THRESHOLD;
  }

  // Mixed infrastructure — average thresholds and warn
  const thresholds = codes.map(code => PROVIDER_THRESHOLDS[code] ?? DEFAULT_THRESHOLD);
  const average = Math.round(thresholds.reduce((a, b) => a + b, 0) / thresholds.length);

  console.warn(
    `[auto-turnoff] Mixed infrastructure on campaign ${campaignName}: ` +
    `providers=[${codes.join(',')}], using averaged threshold ${average}`
  );

  return average;
}
```

### 1.4 Mixed Infrastructure Handling

Best practice is that all tags on a campaign use a single provider. Mixed-infrastructure campaigns are an operational error, not a supported configuration. However, as a safety fallback:

1. Collect all unique `provider_code` values across all accounts in all tags.
2. Look up the threshold for each provider code.
3. Take the arithmetic mean of those thresholds.
4. Round to the nearest integer.
5. Log a warning (see function above).

**Example:** Campaign with 60% Google accounts (threshold 3,800) and 40% Outlook accounts (threshold 5,000):

```
(3800 + 5000) / 2 = 4400
```

Averaged threshold: 4,400:1.

> **Caveat:** Verify with Samuel that all production campaign tags use a single provider before v2 ships. The averaging path should never trigger in production. If it does, treat it as a data quality issue, not expected behavior. Tracking note: add to `caveats.md`.

### 1.5 KV Cache

Infrastructure data is stable — sending pools don't change mid-campaign. Caching avoids repeated `list_accounts` calls on every run.

| Property | Value |
|----------|-------|
| Key format | `infra:{campaignId}` |
| Value | Threshold as a string integer |
| TTL | 7 days (604,800 seconds) |
| Invalidation | Manual only (e.g., if a campaign's sending pool is rebuilt) |

On cache hit, `getInfraThreshold` returns immediately without any MCP calls.

---

## 2. Minimum Sends Gate Scaling

### 2.1 Problem with v1 Gate

v1 uses the threshold as both the minimum sends gate and the kill ceiling. This was fine with a single flat value. With differentiated thresholds, the behavior diverges:

- Warm Leads at 500:1 ceiling would require only 500 sends before evaluation — a variant could be killed on noise with minimal data.
- ERC at 6,000:1 would require 6,000 sends — roughly consistent with v1's behavior but now explicit.

### 2.2 Decision

The gate scales with the threshold. **Gate = threshold value.** This preserves v1's behavior exactly while allowing each product/infra tier to define its own evaluation window.

| Configuration | Threshold / Gate |
|---------------|-----------------|
| Google / Funding | 3,800 |
| SMTP / Funding | 4,500 |
| Outlook / Funding | 5,000 |
| ERC | 6,000 |
| S125 | 14,000 |
| Warm Leads | 500 |

The `evaluateVariant` function signature is unchanged — the `threshold` parameter already controls both behaviors. No additional gate parameter is introduced.

---

## 3. Product-Specific Thresholds (Feature 3.2)

### 3.1 Product Definitions

Four product types are recognized:

| Product | Workspaces | Threshold | Infrastructure Split |
|---------|------------|-----------|---------------------|
| FUNDING | Renaissance 1-7, The Eagles, Equinox, The Dyad, The Gatekeepers, Koi and Destroy, Outlook 1-3, Prospects Power, Automated applications | Per-infra (section 1) | Yes |
| ERC | ERC 1, ERC 2 | 6,000 | No (100% Outlook) |
| S125 | Section 125 1, Section 125 2 | 14,000 | No (mixed, low volume) |
| WARM_LEADS | Warm leads | 500 | No |

ERC and S125 use product-level thresholds directly. Per-infrastructure splitting is deferred for these products — volume is insufficient to justify the added resolution.

### 3.2 Config Changes

Add to `config.ts`:

```typescript
export type Product = 'FUNDING' | 'ERC' | 'S125' | 'WARM_LEADS';

export const WORKSPACE_PRODUCT: Record<string, Product> = {
  // Funding workspaces
  'renaissance-1': 'FUNDING',
  'renaissance-2': 'FUNDING',
  'renaissance-3': 'FUNDING',
  'renaissance-4': 'FUNDING',
  'renaissance-5': 'FUNDING',
  'renaissance-6': 'FUNDING',
  'renaissance-7': 'FUNDING',
  'the-eagles': 'FUNDING',
  'equinox': 'FUNDING',
  'the-dyad': 'FUNDING',
  'the-gatekeepers': 'FUNDING',
  'koi-and-destroy': 'FUNDING',
  'outlook-1': 'FUNDING',
  'outlook-2': 'FUNDING',
  'outlook-3': 'FUNDING',
  'prospects-power': 'FUNDING',
  'automated-applications': 'FUNDING',

  // ERC workspaces
  'erc-1': 'ERC',
  'erc-2': 'ERC',

  // S125 workspaces
  'section-125-1': 'S125',
  'section-125-2': 'S125',

  // Warm Leads workspaces
  'warm-leads': 'WARM_LEADS',
};

export const PRODUCT_THRESHOLDS: Record<Product, number> = {
  FUNDING: 4000,   // Base value only — overridden by getInfraThreshold() at runtime
  ERC: 6000,
  S125: 14000,
  WARM_LEADS: 500,
};
```

> **Note on workspace IDs:** The keys in `WORKSPACE_PRODUCT` are slug-style identifiers used as a documentation convention here. Replace with actual Instantly workspace IDs (UUID or slug) when populating. Source of truth for workspace IDs is the Instantly account under Settings > Workspaces.

### 3.3 Threshold Resolution Function

Add to `threshold-resolver.ts` (new file):

```typescript
import {
  Product,
  WORKSPACE_PRODUCT,
  PRODUCT_THRESHOLDS,
} from './config';
import { getInfraThreshold } from './infrastructure';

export async function resolveThreshold(
  campaign: Campaign,
  mcp: InstantlyMCP,
  kv: KVNamespace
): Promise<number | null> {
  const workspaceId = campaign.workspace_id;
  const product = WORKSPACE_PRODUCT[workspaceId];

  if (!product) {
    // Workspace not monitored — skip
    return null;
  }

  if (product === 'FUNDING') {
    // Per-infrastructure threshold (with KV caching)
    return getInfraThreshold(campaign, mcp, kv);
  }

  // ERC, S125, WARM_LEADS — use product threshold directly
  return PRODUCT_THRESHOLDS[product];
}
```

**Return value:** `null` means the campaign's workspace is not in the monitored set — the caller should skip evaluation entirely. A number means proceed with that threshold.

### 3.4 Resolution Order (Full Flow)

```
campaign.workspace_id
  -> WORKSPACE_PRODUCT lookup
  -> if not found: return null (skip campaign)
  -> if FUNDING: getInfraThreshold(campaign, mcp, kv)
       -> KV cache check
       -> if miss: campaign.email_tag_list -> list_accounts -> provider_code -> PROVIDER_THRESHOLDS
       -> write to KV (7d TTL)
       -> return threshold
  -> if ERC / S125 / WARM_LEADS: return PRODUCT_THRESHOLDS[product]
  -> pass threshold into evaluateVariant(sent, opportunities, threshold)
```

---

## 4. API Call Estimate

### v1 Baseline

~300 API calls per run: 236 campaigns x ~1.3 calls average (campaign fetch + occasional extras).

### v2 Additions

`getInfraThreshold` adds one `list_accounts` call per tag UUID per Funding campaign. Funding accounts for approximately 180 of the 236 campaigns. Assuming an average of 1 tag per campaign (most common case): +180 calls on the first run, then 0 on subsequent runs (KV cache hit, 7-day TTL).

| Run type | Calls | Notes |
|----------|-------|-------|
| v1 steady state | ~300 | Baseline |
| v2 cold start (first run) | ~480 | +180 infra lookups |
| v2 steady state (cache warm) | ~300 | Same as v1 |

### Cloudflare Limits

Paid Workers plan: 10M subrequests/month.

```
480 calls x 24 runs/day x 30 days = 345,600 calls/month
```

345,600 / 10,000,000 = **3.5% of monthly limit.** Well within bounds.

Cache warmup resets on KV expiry (every 7 days), so the cold-start figure applies to the first run of each 7-day window, not every run.

---

## 5. Summary of Config Changes

All changes are additive. No existing config keys are modified.

**`config.ts` additions:**
- `PROVIDER_THRESHOLDS: Record<number, number>` — provider code to threshold
- `DEFAULT_THRESHOLD: number` — fallback when infrastructure cannot be resolved
- `Product` type — union of four product strings
- `WORKSPACE_PRODUCT: Record<string, Product>` — workspace ID to product
- `PRODUCT_THRESHOLDS: Record<Product, number>` — product to threshold

**New files:**
- `infrastructure.ts` — `getInfraThreshold(campaign, mcp, kv): Promise<number>`
- `threshold-resolver.ts` — `resolveThreshold(campaign, mcp, kv): Promise<number | null>`

**Unchanged:**
- `evaluator.ts` — `evaluateVariant(sent, opportunities, threshold)` signature and logic unchanged
- All existing v1 config keys

---

## 6. Open Items

| Item | Owner | Status |
|------|-------|--------|
| Confirm actual workspace IDs (UUIDs/slugs) for WORKSPACE_PRODUCT map | Sam | Open |
| Verify with Samuel that all Funding campaign tags use a single provider (no mixed-infra in production) | Sam | Open |
| Confirm ERC is 100% Outlook (provider_code 3) before skipping per-infra split | Sam | Open |
| Confirm S125 volume is insufficient for per-infra split or plan future milestone | Sam | Open |
| Decide manual KV invalidation procedure if a campaign's sending pool is rebuilt | Engineering | Open |
