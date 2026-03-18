# Auto Turn-Off v2-v3: Engineering Spec

**Created:** [2026-03-15]
**Purpose:** Complete build specification for a fresh Claude Code session to execute without questions.
**Prereq:** v1 must be built first. This spec modifies v1 code in place.
**Build time estimate:** ~20-30 minutes with parallel agents.

---

## Required Reading (Load Order)

The executing session MUST read these files BEFORE building, in this order:

1. **This file** (`builds/auto-turn-off/v2-v3-engineering-spec.md`) — build instructions
2. **v1 source files** (`builds/auto-turn-off/src/*.ts`) — the existing codebase being modified
3. **Detailed spec sections** (`builds/auto-turn-off/spec-sections/thresholds.md`, `warning-and-filters.md`, `routing-and-dashboard.md`) — implementation details for each feature area
4. **Research data** (`builds/auto-turn-off/funding-sheet-mapping.md`, `provider-code-mapping.md`, `warm-leads-analysis.md`) — data informing config values

Do NOT read: `vision.md`, `v1-spec.md`, `cloudflare_test_terminal_output.md`, any files outside `builds/auto-turn-off/`.

---

## Summary of Changes

v2-v3 modifies the existing v1 codebase. No new services or infrastructure. Same Cloudflare Worker, same MCP connection, same KV store.

**What changes:**
- Threshold resolution: flat 4,000 → per-infrastructure + per-product
- Workspace matching: name-based → ID-based
- CM routing: campaign title only → workspace default (primary) + title parsing (fallback)
- New: OFF campaign filter (skip before evaluation)
- New: Last variant early warning (80% of threshold, Slack alert)
- New: Audit log dashboard (HTML page at `/__dashboard`)
- New: Defensive validation (sequences guard, variant bounds logging)

**What does NOT change:**
- MCP client (`mcp-client.ts`) — untouched
- Core evaluator logic (`evaluateVariant`, `safetyCheck`) — signature and behavior unchanged
- Slack notification functions for kill/block — format unchanged
- KV lock mechanism — unchanged
- Cron schedule — unchanged (hourly)

---

## Architecture Overview (v2-v3)

```
[Cloudflare Worker Cron Trigger (hourly)]
    |
    v
[Orchestrator - index.ts]
    |
    +--> [MCP Client - mcp-client.ts]  --> SSE/JSON-RPC --> [Railway MCP Server]
    |         |                                                    |
    |         v                                                    v
    |    [Instantly Layer - instantly.ts]                    [Instantly API]
    |
    +--> [Threshold Resolver - thresholds.ts] (NEW - resolves per-infra/product threshold)
    |         |
    |         +--> [Cloudflare KV] (cache: infra:{campaignId} -> threshold, 7d TTL)
    |
    +--> [Evaluator - evaluator.ts] (gate, evaluate, safety — PLUS early warning check)
    |
    +--> [Router - router.ts] (NEW - workspace CM default + campaign title fallback)
    |
    +--> [Slack - slack.ts] (kill + block + WARNING notification types)
    |
    +--> [Dashboard - dashboard.ts] (NEW - HTML page serving audit log)
    |
    +--> [Cloudflare KV] (run lock, audit log, warning dedup, infra cache)
```

## File Structure (changes from v1)

```
builds/auto-turn-off/
  src/
    index.ts          -- MODIFIED: ID matching, OFF filter, threshold resolver, warning check, dashboard route
    mcp-client.ts     -- UNCHANGED
    instantly.ts      -- MODIFIED: add listAccounts() for infra detection
    evaluator.ts      -- MODIFIED: add checkLastVariantWarning(), variant bounds logging
    parser.ts         -- UNCHANGED (still used as fallback in router)
    slack.ts          -- MODIFIED: add warning notification format
    types.ts          -- MODIFIED: add email_tag_list to CampaignDetail, add new interfaces
    config.ts         -- MODIFIED: workspace configs (ID-based), provider thresholds, product thresholds
    thresholds.ts     -- NEW: getInfraThreshold(), resolveThreshold()
    router.ts         -- NEW: resolveCmChannel() with workspace default + title fallback
    dashboard.ts      -- NEW: serveDashboard() HTML page from KV audit log
  wrangler.toml       -- UNCHANGED
  package.json        -- UNCHANGED
  tsconfig.json       -- UNCHANGED
```

---

## Feature Specifications

### Feature 1: Per-Infrastructure Thresholds + Product-Specific Thresholds

**Full spec:** `spec-sections/thresholds.md`

**Key decisions:**
- Provider codes: 1=SMTP/OTD (4,500:1), 2=Google (3,800:1), 3=Outlook (5,000:1)
- Product thresholds: Funding=per-infra, ERC=6,000:1, S125=14,000:1, Warm Leads=500:1
- Minimum sends gate = threshold (scales with product/infra)
- No 20% buffer applied (confirmed by Ido)
- Mixed-infra campaigns: average the thresholds, log warning
- Infrastructure cached in KV per campaign (7-day TTL)
- Detection chain: campaign.email_tag_list → list_accounts(tag_ids) → provider_code → threshold

**New file `src/thresholds.ts`:**
```typescript
export async function resolveThreshold(
  workspaceId: string,
  campaign: CampaignDetail,
  api: InstantlyApi,
  kv: KVNamespace
): Promise<number | null>
// Returns null if workspace not monitored, number otherwise

export async function getInfraThreshold(
  campaign: CampaignDetail,
  api: InstantlyApi,
  kv: KVNamespace
): Promise<number>
// For Funding campaigns only. Resolves provider_code → threshold.
```

**Config additions (`src/config.ts`):**
```typescript
export type Product = 'FUNDING' | 'ERC' | 'S125' | 'WARM_LEADS';

export const PROVIDER_THRESHOLDS: Record<number, number> = {
  1: 4500,  // SMTP / OTD
  2: 3800,  // Google
  3: 5000,  // Outlook
};
export const DEFAULT_THRESHOLD = 4000;

export const PRODUCT_THRESHOLDS: Record<Product, number> = {
  FUNDING: 4000,  // overridden by per-infra at runtime
  ERC: 6000,
  S125: 14000,
  WARM_LEADS: 500,
};

// Replaces FUNDING_WORKSPACE_NAMES
export interface WorkspaceConfig {
  id: string;
  name: string;
  product: Product;
  defaultCm: string | null;
}

export const WORKSPACE_CONFIGS: WorkspaceConfig[] = [
  // Funding — single-CM workspaces
  { id: 'renaissance-1', name: 'Renaissance 1', product: 'FUNDING', defaultCm: 'IDO' },
  { id: 'renaissance-2', name: 'Renaissance 2', product: 'FUNDING', defaultCm: 'EYVER' },
  { id: 'the-gatekeepers', name: 'The Gatekeepers', product: 'FUNDING', defaultCm: 'BRENDAN' },
  { id: 'equinox', name: 'Equinox', product: 'FUNDING', defaultCm: 'LEO' },
  { id: 'the-dyad', name: 'The Dyad', product: 'FUNDING', defaultCm: 'CARLOS' },
  { id: 'koi-and-destroy', name: 'Koi and Destroy', product: 'FUNDING', defaultCm: 'TOMI' },
  { id: 'outlook-2', name: 'Outlook 2', product: 'FUNDING', defaultCm: 'MARCOS' },
  { id: 'prospects-power', name: 'Prospects Power', product: 'FUNDING', defaultCm: 'SHAAN' },
  { id: 'automated-applications', name: 'Automated applications', product: 'FUNDING', defaultCm: 'IDO' },
  { id: 'outlook-1', name: 'Outlook 1', product: 'FUNDING', defaultCm: 'IDO' },
  // Funding — shared workspaces (no single default CM, fall through to campaign title parsing)
  { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null },
  { id: 'renaissance-5', name: 'Renaissance 5', product: 'FUNDING', defaultCm: null },
  { id: 'the-eagles', name: 'The Eagles', product: 'FUNDING', defaultCm: null },
  // Funding — unassigned workspaces (no CM data in Inbox Hub — verify with Samuel)
  { id: 'renaissance-3', name: 'Renaissance 3', product: 'FUNDING', defaultCm: null },
  { id: 'renaissance-6', name: 'Renaissance 6', product: 'FUNDING', defaultCm: null },
  { id: 'renaissance-7', name: 'Renaissance 7', product: 'FUNDING', defaultCm: null },
  { id: 'outlook-3', name: 'Outlook 3', product: 'FUNDING', defaultCm: null },
  // ERC
  { id: 'erc-1', name: 'ERC 1', product: 'ERC', defaultCm: null },
  { id: 'erc-2', name: 'ERC 2', product: 'ERC', defaultCm: null },
  // S125
  { id: 'section-125-1', name: 'Section 125 1', product: 'S125', defaultCm: 'IDO' },
  { id: 'section-125-2', name: 'Section 125 2', product: 'S125', defaultCm: null },
  // Warm Leads
  { id: 'warm-leads', name: 'Warm leads', product: 'WARM_LEADS', defaultCm: 'IDO' },
];
```

**IMPORTANT:** Workspace IDs above are slug-format from the dry-run `list_workspaces` response. The executing session MUST verify these match the actual API response. If Instantly uses UUIDs instead of slugs, replace accordingly.

**`instantly.ts` addition:**
```typescript
async listAccounts(tagIds: string): Promise<Array<{ provider_code?: number; [key: string]: unknown }>>
// Calls list_accounts MCP tool with tag_ids parameter
```

---

### Feature 2: Last Variant Early Warning

**Full spec:** `spec-sections/warning-and-filters.md`

**Key decisions:**
- Triggers at 80% of threshold consumed (configurable constant)
- Only fires when a step has exactly 1 active variant
- KV dedup: `warning:{campaignId}:{stepIndex}` with 24h TTL
- Only checks steps where evaluateStep returned no kills AND no blocked variant (avoids double-notification)
- New Slack message type with remaining sends shown numerically

**`evaluator.ts` addition:**
```typescript
export interface LastVariantWarning {
  warn: true;
  variantIndex: number;
  variantLabel: string;
  sent: number;
  threshold: number;
  remaining: number;
  pctConsumed: number;
  opportunities: number;
}

export function checkLastVariantWarning(
  step: Step,
  analytics: StepAnalytics[],
  stepIndex: number,
  threshold: number
): LastVariantWarning | null
```

**`slack.ts` addition:**
```typescript
export async function sendWarningNotification(
  warning: LastVariantWarning,
  campaignName: string,
  workspaceName: string,
  channelId: string,
  env: Env
): Promise<void>
```

**Constants:**
```typescript
export const LAST_VARIANT_WARNING_PCT = 0.8;
export const WARNING_DEDUP_TTL_SECONDS = 86400;
```

---

### Feature 3: OFF Campaign Filter

**Full spec:** `spec-sections/warning-and-filters.md`

**Key decision:** Skip campaigns with "OFF" at the start of the name (after leading emojis/whitespace), followed by a space or dash. Case-insensitive.

**Implementation in `index.ts`:**
```typescript
function isOffCampaign(name: string): boolean {
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF[\s\-]/iu.test(name);
}
```

Placed before any API calls in the campaign loop. Track `offCampaignCount` per workspace in summary logs.

---

### Feature 4: Workspace ID Matching + CM Routing

**Full spec:** `spec-sections/routing-and-dashboard.md` (when available)

**Key decisions:**
- Workspace matching by ID (stable) instead of name (can change)
- `WORKSPACE_CONFIGS` array replaces `FUNDING_WORKSPACE_NAMES` set
- CM routing priority: workspace defaultCm → campaign title parsing → fallback channel
- CM_CHANNEL_MAP stays hardcoded (Sam's decision)

**New file `src/router.ts`:**
```typescript
import { CM_CHANNEL_MAP } from './config';
import type { WorkspaceConfig } from './config';
import { parseCmChannel } from './parser';

export function resolveCmChannel(
  workspaceConfig: WorkspaceConfig,
  campaignName: string,
  fallbackChannel: string
): string {
  // 1. Workspace default CM
  if (workspaceConfig.defaultCm) {
    const channel = CM_CHANNEL_MAP[workspaceConfig.defaultCm];
    if (channel) return channel;
  }
  // 2. Campaign title parsing (existing parser.ts logic)
  return parseCmChannel(campaignName, fallbackChannel);
}
```

**Orchestrator change (`index.ts`):**
```typescript
// Old:
const fundingWorkspaces = allWorkspaces.filter((ws) => FUNDING_WORKSPACE_NAMES.has(ws.name));

// New:
const configMap = new Map(WORKSPACE_CONFIGS.map(c => [c.id, c]));
const monitoredWorkspaces = allWorkspaces.filter((ws) => configMap.has(ws.id));

// Validation: warn if configured workspaces are missing from API
for (const config of WORKSPACE_CONFIGS) {
  if (!allWorkspaces.some(ws => ws.id === config.id)) {
    console.warn(`[auto-turnoff] Configured workspace ${config.name} (${config.id}) not found in API response`);
  }
}
```

---

### Feature 5: Audit Log Dashboard

**Full spec:** `spec-sections/routing-and-dashboard.md` (when available)

**Key decisions:**
- Served at `/__dashboard` on the same Worker
- No auth (URL not publicly discoverable)
- Reads KV audit log entries (`log:` prefix) and run summaries (`run:` prefix)
- Query params: `?date=2026-03-15`, `?type=DISABLED|BLOCKED|all`, `?days=7`
- Inline HTML/CSS (dark mode, minimal, no external deps)
- Grouped by date with run summary cards and action table

**New file `src/dashboard.ts`:**
```typescript
export async function serveDashboard(
  kv: KVNamespace,
  params: URLSearchParams
): Promise<Response>
// Returns Response with Content-Type: text/html
```

**`index.ts` fetch handler addition:**
```typescript
if (url.pathname === '/__dashboard') {
  return serveDashboard(env.KV, url.searchParams);
}
```

---

### Feature 6: Defensive Fixes

**Full spec:** `spec-sections/warning-and-filters.md`

**6a. Sequences validation (`index.ts`):**
Guard before `campaignDetail.sequences[0]` access:
```typescript
if (!campaignDetail.sequences || campaignDetail.sequences.length === 0) {
  console.warn(`[auto-turnoff] Campaign ${campaign.id} (${campaign.name}) has no sequences, skipping`);
  return;
}
```

**6b. Variant index bounds logging (`evaluator.ts`):**
Log when analytics references non-existent variant (preserves existing filter behavior but surfaces the condition):
```typescript
if (variant === undefined) {
  console.warn(`[auto-turnoff] Analytics references non-existent variant ${variantIdx} in step ${stepIndex}`);
  return false;
}
```

**6c. Type addition (`types.ts`):**
```typescript
export interface CampaignDetail {
  // ... existing fields ...
  email_tag_list?: string[];  // Tag UUIDs for infrastructure detection
}
```

---

## Agent Build Plan

### Phase 1: Parallel (3 agents, no dependencies)

#### Agent A: Config + Types + Thresholds
**Model:** sonnet
**Files to modify:** `src/config.ts`, `src/types.ts`
**Files to create:** `src/thresholds.ts`

- Replace `FUNDING_WORKSPACE_NAMES` with `WORKSPACE_CONFIGS` array
- Add `Product` type, `PROVIDER_THRESHOLDS`, `PRODUCT_THRESHOLDS`, `DEFAULT_THRESHOLD`
- Add `WorkspaceConfig` interface
- Add `email_tag_list` to `CampaignDetail`
- Add `LastVariantWarning` interface
- Create `thresholds.ts` with `resolveThreshold()` and `getInfraThreshold()`

#### Agent B: Evaluator + Warning + Slack
**Model:** sonnet
**Files to modify:** `src/evaluator.ts`, `src/slack.ts`

- Add `checkLastVariantWarning()` function to evaluator
- Add variant bounds logging to `activeAnalytics` filter
- Add `sendWarningNotification()` to slack.ts
- Add `LAST_VARIANT_WARNING_PCT` and `WARNING_DEDUP_TTL_SECONDS` constants

#### Agent C: Router + Dashboard
**Model:** sonnet
**Files to create:** `src/router.ts`, `src/dashboard.ts`

- Create `router.ts` with `resolveCmChannel()` (workspace default + title fallback)
- Create `dashboard.ts` with `serveDashboard()` (HTML page reading KV audit log)

### Phase 2: Sequential (1 agent, after ALL Phase 1 agents complete)

#### Agent D: Orchestrator Integration
**Model:** sonnet
**Files to modify:** `src/index.ts`, `src/instantly.ts`

- Must READ all Phase 1 output files before writing
- Add `listAccounts()` to `instantly.ts`
- Rewrite workspace matching (ID-based via WORKSPACE_CONFIGS)
- Add workspace validation logging
- Add OFF campaign filter (`isOffCampaign()`)
- Wire `resolveThreshold()` into campaign processing
- Wire `resolveCmChannel()` replacing direct `parseCmChannel()` calls
- Add early warning check after evaluateStep
- Add `/__dashboard` route to fetch handler
- Add sequences guard
- Update audit log entries to include product and infrastructure fields

---

## Orchestrator Flow (v2-v3)

```
1. ACQUIRE LOCK (unchanged)

2. CONNECT MCP (unchanged)

3. GET MONITORED WORKSPACES
   - Call listWorkspaces()
   - Filter to WORKSPACE_CONFIGS by ID (not name)
   - Validate: warn if any configured IDs missing from API
   - Log: "Processing N workspaces (F Funding, E ERC, S S125, W Warm Leads)"

4. FOR EACH WORKSPACE (sequential):
   a. Look up WorkspaceConfig for this workspace
   b. GET active campaigns
   c. Log: "{N} active campaigns ({M} skipped OFF)"

   d. FOR EACH CAMPAIGN (parallel with concurrency cap):
      i.    Check isOffCampaign() → skip if true
      ii.   Resolve threshold: resolveThreshold(workspaceId, campaign, api, kv)
            → null means skip (shouldn't happen since workspace is monitored)
      iii.  GET step analytics
      iv.   QUICK GATE: any variant sent >= threshold?
      v.    GET campaign details
      vi.   Sequences guard: skip if empty
      vii.  FOR EACH STEP:
            - evaluateStep() → kills, blocked
            - Process kills (resolve CM via router, send notifications, audit log)
            - Process blocked (send LAST_VARIANT notification, audit log)
            - If no kills and no blocked: checkLastVariantWarning()
              → If warning + not deduped: send warning notification, set KV dedup key

5. LOG RUN SUMMARY (unchanged + add variantsBlocked count)

6. WRITE RUN SUMMARY TO KV (unchanged)

7. RELEASE LOCK (unchanged)

8. CLOSE MCP (unchanged)
```

---

## What NOT to Build

- No retry logic (hourly cron IS the retry)
- No per-infrastructure thresholds for ERC/S125/Warm Leads (insufficient volume)
- No subsequence evaluation (Instantly subsequences don't support variants)
- No auth on dashboard (URL not publicly discoverable)
- No CM_CHANNEL_MAP in KV (stays hardcoded per Sam's decision)
- No 20% buffer on thresholds (confirmed by Ido)
- No concurrent modification detection (removed — hard rule: CMs don't edit live copy)

---

## Verification Plan

After deploying v2-v3 in dry-run mode:

1. Trigger manual run via `wrangler dev` + `curl /__scheduled`
2. Check logs for:
   - All workspaces matched by ID (no "not found" warnings)
   - OFF campaigns skipped with correct count per workspace
   - Per-infrastructure thresholds resolving correctly (Google=3800, Outlook=5000)
   - ERC campaigns using 6,000 threshold, S125 using 14,000
   - Warm leads using 500 threshold
   - Early warnings firing on single-variant steps at 80%+
   - KV cache hits on second run (no list_accounts calls)
3. Visit `/__dashboard` in browser — verify audit log entries render correctly
4. Compare kill decisions with v1 dry-run — Funding should have fewer Outlook kills (higher threshold) and more Google kills (lower threshold)
5. Run for 24-48 hours in dry-run, then proceed with phased deployment (see roadmap.md Deployment Plan)

---

## Caveats and Disclaimers

See `builds/auto-turn-off/caveats-and-action-items.md` for the full list. Key items:

- **No 20% buffer.** Thresholds are kill ceilings, not warning zones. May need adjustment after live observation.
- **OFF campaigns skipped.** Campaigns with OFF prefix are not evaluated. CMs should be aware.
- **Mixed-infra averaging is a fallback.** All campaign tags should use a single provider. Verify with Samuel.
- **Workspace IDs must be verified.** The slugs in WORKSPACE_CONFIGS are from dry-run observation. Confirm they match the actual API before deploying.
- **40% of Funding tags have no CM.** Notifications for unassigned workspaces go to fallback channel.
- **ERC/S125 CM fields are mostly empty.** Notifications go to fallback channel unless workspace defaultCm is set.
- **Hard rule: CMs must not edit live variant copy.** Samuel to communicate before go-live.
- **First-run purge is phased.** Validate 1 kill per CM first, then full purge, then autopilot.

---

## Agent Dispatch Summary

| Agent | Phase | Model | Files | Dependencies |
|-------|-------|-------|-------|-------------|
| A: Config + Types + Thresholds | 1 (parallel) | sonnet | config.ts, types.ts, thresholds.ts | None |
| B: Evaluator + Warning + Slack | 1 (parallel) | sonnet | evaluator.ts, slack.ts | None |
| C: Router + Dashboard | 1 (parallel) | sonnet | router.ts, dashboard.ts | None |
| D: Orchestrator Integration | 2 (sequential) | sonnet | index.ts, instantly.ts | Reads all Phase 1 outputs |
