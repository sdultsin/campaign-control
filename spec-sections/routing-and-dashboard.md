# Auto Turn-Off v2: Workspace ID Matching, CM Routing, and Audit Log Dashboard

**Spec version:** v2
**Features covered:** 2.3 (workspace-level CM routing), 2.4 (audit log dashboard), plus the ID-based workspace matching prerequisite
**Status:** Draft
**Companion spec:** `spec-sections/thresholds.md` (features 2.1, 3.2)

---

## Background

v1 matches workspaces by name using a string set called `FUNDING_WORKSPACE_NAMES`. CM routing is done by parsing campaign titles with a regex that extracts names from parentheses, then looking up the result in a hardcoded `CM_CHANNEL_MAP`. This works for campaigns with a CM name in the title, but breaks for:

- Campaigns that belong to a single-CM workspace but have no CM name in the title (ERC, Outlook generics, Automated Applications)
- Any workspace whose name is changed in Instantly — the system silently stops evaluating it

v2 fixes both problems. This document covers three changes that go together:

1. **Workspace ID matching** — match by stable API ID instead of mutable name
2. **Workspace-level CM routing** — use a per-workspace default CM as the primary lookup, with campaign title parsing as the fallback for shared workspaces
3. **Audit log dashboard** — an HTML page served by the Worker that renders KV audit log entries by date

These are ordered as prerequisites: ID matching must land first because it provides the `WorkspaceConfig` struct that CM routing reads from. The dashboard is independent and can ship in the same deployment.

---

## 1. Workspace ID-Based Matching

### 1.1 Problem

`FUNDING_WORKSPACE_NAMES` matches by name. Names are user-controlled strings in Instantly's UI. If Ido or Darcy renames "Renaissance 1" to "Renaissance Legacy 1", the system silently stops evaluating it. There is no error — the filter just returns nothing for that workspace.

Workspace IDs are API-assigned slugs (e.g., `renaissance-1`, `the-gatekeepers`). They are stable across renames and do not change after workspace creation.

### 1.2 Config Change

Replace `FUNDING_WORKSPACE_NAMES` with a structured `WORKSPACE_CONFIGS` array. The `name` field is kept for logging only and has no effect on filtering.

Remove from `config.ts`:
```typescript
export const FUNDING_WORKSPACE_NAMES = new Set([
  'Renaissance 1',
  'Renaissance 2',
  // ...
]);
```

Add to `config.ts`:
```typescript
export type Product = 'FUNDING' | 'ERC' | 'S125' | 'WARM_LEADS';

export interface WorkspaceConfig {
  id: string;           // Instantly workspace ID (stable slug)
  name: string;         // Display name for logging — does NOT affect matching
  product: Product;
  defaultCm: string | null;  // CM name key from CM_CHANNEL_MAP, or null for shared/unassigned workspaces
}

export const WORKSPACE_CONFIGS: WorkspaceConfig[] = [
  // ---- Single-CM workspaces (primary CM routing via defaultCm) ----
  { id: 'renaissance-1',          name: 'Renaissance 1',          product: 'FUNDING',     defaultCm: 'IDO' },
  { id: 'renaissance-2',          name: 'Renaissance 2',          product: 'FUNDING',     defaultCm: 'EYVER' },
  { id: 'equinox',                name: 'Equinox',                product: 'FUNDING',     defaultCm: 'LEO' },
  { id: 'the-dyad',               name: 'The Dyad',               product: 'FUNDING',     defaultCm: 'CARLOS' },
  { id: 'the-gatekeepers',        name: 'The Gatekeepers',        product: 'FUNDING',     defaultCm: 'BRENDAN' },
  { id: 'koi-and-destroy',        name: 'Koi and Destroy',        product: 'FUNDING',     defaultCm: 'TOMI' },
  { id: 'prospects-power',        name: 'Prospect Power',         product: 'FUNDING',     defaultCm: 'SHAAN' },
  { id: 'outlook-1',              name: 'Outlook 1',              product: 'FUNDING',     defaultCm: 'IDO' },
  { id: 'outlook-2',              name: 'Outlook 2',              product: 'FUNDING',     defaultCm: 'MARCOS' },
  { id: 'automated-applications', name: 'Automated Applications', product: 'FUNDING',     defaultCm: 'IDO' },

  // ---- Shared workspaces (campaign title parsing is primary) ----
  { id: 'renaissance-4',          name: 'Renaissance 4',          product: 'FUNDING',     defaultCm: null },  // 5 CMs: Alex, Andres, Carlos, Ido, Leo
  { id: 'renaissance-5',          name: 'Renaissance 5',          product: 'FUNDING',     defaultCm: null },  // 3 CMs: Alex, Eyver, Marcos
  { id: 'the-eagles',             name: 'The Eagles',             product: 'FUNDING',     defaultCm: null },  // 2 CMs: Lautaro, Samuel

  // ---- Unassigned workspaces (no CM data in Inbox Hub — fallback channel) ----
  { id: 'renaissance-3',          name: 'Renaissance 3',          product: 'FUNDING',     defaultCm: null },
  { id: 'renaissance-6',          name: 'Renaissance 6',          product: 'FUNDING',     defaultCm: null },
  { id: 'renaissance-7',          name: 'Renaissance 7',          product: 'FUNDING',     defaultCm: null },
  { id: 'outlook-3',              name: 'Outlook 3',              product: 'FUNDING',     defaultCm: null },

  // ---- ERC workspaces ----
  { id: 'erc-1',                  name: 'ERC 1',                  product: 'ERC',         defaultCm: null },
  { id: 'erc-2',                  name: 'ERC 2',                  product: 'ERC',         defaultCm: null },

  // ---- Section 125 workspaces ----
  { id: 'section-125-1',          name: 'Section 125 1',          product: 'S125',        defaultCm: 'IDO' },
  { id: 'section-125-2',          name: 'Section 125 2',          product: 'S125',        defaultCm: null },

  // ---- Warm Leads ----
  { id: 'warm-leads',             name: 'Warm Leads',             product: 'WARM_LEADS',  defaultCm: 'IDO' },
];
```

**Open item:** The workspace IDs above are slugs inferred from dry-run `list_workspaces` output (truncated at 500 chars). Confirm the exact ID values for every workspace against a full `list_workspaces` response before deploying. The IDs that were visible in the dry-run log: `koi-and-destroy`, `renaissance-1`, `warm-leads`, `renaissance-3`, `the-gatekeepers`, `equinox`, `renaissance-2`, `renaissance-5`, `section-125-1`, `the-dyad`, `outlook-2`. IDs for the remaining workspaces need confirmation.

### 1.3 Orchestrator Change

In `index.ts`, replace the name-based workspace filter:

```typescript
// v1 (remove):
import { FUNDING_WORKSPACE_NAMES } from './config';
const fundingWorkspaces = allWorkspaces.filter((ws) => FUNDING_WORKSPACE_NAMES.has(ws.name));

// v2 (replace with):
import { WORKSPACE_CONFIGS } from './config';

const configuredIds = new Set(WORKSPACE_CONFIGS.map((c) => c.id));
const monitoredWorkspaces = allWorkspaces.filter((ws) => configuredIds.has(ws.id));

// Validate: warn if any configured ID is not returned by the API
const returnedIds = new Set(allWorkspaces.map((ws) => ws.id));
for (const config of WORKSPACE_CONFIGS) {
  if (!returnedIds.has(config.id)) {
    console.warn(
      `[auto-turnoff] Configured workspace ID "${config.id}" (${config.name}) not found in list_workspaces response. ` +
      `Workspace may have been deleted or renamed. Update WORKSPACE_CONFIGS.`
    );
  }
}
```

This validation converts silent mismatches into explicit warnings in the Workers log. A missing ID means either the workspace was deleted or the configured ID string is wrong.

### 1.4 Types Update

The `Workspace` type already has `id` and `name`. Add an index function to look up the config for a given workspace ID, usable throughout the orchestrator and routing layer:

```typescript
// config.ts — add below WORKSPACE_CONFIGS:
export function getWorkspaceConfig(workspaceId: string): WorkspaceConfig | null {
  return WORKSPACE_CONFIGS.find((c) => c.id === workspaceId) ?? null;
}
```

---

## 2. Workspace-Level CM Routing (Feature 2.3)

### 2.1 Problem

v1 relies entirely on campaign title parsing to route notifications. This fails for:

- **Single-CM workspaces with generic campaign names:** Outlook 1 campaigns like `Construction 2 - Outlook` or `Auto - Google + Others` have no CM name in the title. In v1, these fall through to `SLACK_FALLBACK_CHANNEL`.
- **ERC campaigns:** Titles like `ERC 1`, `ERC 3 Intent` contain no CM name.
- **Automated Applications campaigns:** No consistent naming pattern.

From the dry-run against 236 campaigns, campaign title parsing fails for a significant portion of campaigns in these workspaces. These are the exact campaigns most likely to accumulate underperforming variants, since they're higher-volume, less-managed campaigns.

### 2.2 Routing Priority

The new routing priority for a given campaign:

```
1. Workspace default CM  —  WORKSPACE_CONFIGS[workspaceId].defaultCm (non-null)
2. Campaign title parsing  —  existing parseCmChannel() logic in parser.ts
3. SLACK_FALLBACK_CHANNEL  —  global env var, set before live deployment
```

Priority 1 is the primary lookup for the 10 single-CM workspaces where `defaultCm` is set. Priority 2 only runs when `defaultCm` is null (shared workspaces: Renaissance 4, Renaissance 5, The Eagles) or when the `defaultCm` key has no entry in `CM_CHANNEL_MAP` (safety fallback).

### 2.3 New Function

Replace `parseCmChannel()` calls in `index.ts` with a new `resolveCmChannel()` function. Add to `parser.ts`:

```typescript
import { WorkspaceConfig, CM_CHANNEL_MAP } from './config';

/**
 * Resolve the Slack channel ID for a campaign notification.
 *
 * Priority:
 *   1. Workspace default CM (WorkspaceConfig.defaultCm)
 *   2. Campaign title parsing (parseCmChannel)
 *   3. fallbackChannel
 */
export function resolveCmChannel(
  workspaceConfig: WorkspaceConfig,
  campaignName: string,
  fallbackChannel: string
): string {
  // Priority 1: workspace default CM
  if (workspaceConfig.defaultCm !== null) {
    const channel = CM_CHANNEL_MAP[workspaceConfig.defaultCm];
    if (channel) {
      return channel;
    }
    // defaultCm key doesn't exist in CM_CHANNEL_MAP — log and fall through
    console.warn(
      `[auto-turnoff] Workspace "${workspaceConfig.name}" has defaultCm "${workspaceConfig.defaultCm}" ` +
      `but no matching entry in CM_CHANNEL_MAP. Falling back to title parsing.`
    );
  }

  // Priority 2: campaign title parsing
  return parseCmChannel(campaignName, fallbackChannel);
}

/**
 * Resolve the CM name string for a campaign (for logging and audit records).
 * Returns null if unresolvable.
 */
export function resolveCmName(
  workspaceConfig: WorkspaceConfig,
  campaignName: string
): string | null {
  if (workspaceConfig.defaultCm !== null) {
    return workspaceConfig.defaultCm;
  }
  return parseCmName(campaignName);
}
```

### 2.4 Orchestrator Update

In `index.ts`, the campaign processing loop currently calls:

```typescript
// v1 (remove):
const channelId = parseCmChannel(campaign.name, env.SLACK_FALLBACK_CHANNEL);
```

Replace with:

```typescript
// v2:
import { getWorkspaceConfig, WORKSPACE_CONFIGS } from './config';
import { resolveCmChannel, resolveCmName } from './parser';

// Inside the workspace loop, after filtering monitoredWorkspaces:
const wsConfig = getWorkspaceConfig(workspace.id);
if (!wsConfig) {
  console.error(`[auto-turnoff] No config for workspace ${workspace.id} — skipping.`);
  continue;
}

// Inside the campaign loop:
const channelId = resolveCmChannel(wsConfig, campaign.name, env.SLACK_FALLBACK_CHANNEL);
const cmName = resolveCmName(wsConfig, campaign.name);
```

`cmName` is passed into `KillAction` for audit log records and notification messages. It will be null for unassigned workspaces (Renaissance 3, 6, 7, Outlook 3) — the notification still routes to the fallback channel.

### 2.5 Routing Coverage After v2

| Workspace | CM Routing Source | Notification Destination |
|-----------|------------------|-------------------------|
| Renaissance 1 | Workspace default | notifications-ido |
| Renaissance 2 | Workspace default | notifications-eyver |
| Equinox | Workspace default | notifications-leo |
| The Dyad | Workspace default | notifications-carlos |
| The Gatekeepers | Workspace default | notifications-brendan |
| Koi and Destroy | Workspace default | notifications-tomi |
| Prospect Power | Workspace default | notifications-shaan |
| Outlook 1 | Workspace default | notifications-ido |
| Outlook 2 | Workspace default | notifications-marcos |
| Automated Applications | Workspace default | notifications-ido |
| Renaissance 4 | Campaign title parsing | Per-CM channel |
| Renaissance 5 | Campaign title parsing | Per-CM channel |
| The Eagles | Campaign title parsing | Per-CM channel |
| Renaissance 3 | Neither (unassigned) | SLACK_FALLBACK_CHANNEL |
| Renaissance 6 | Neither (unassigned) | SLACK_FALLBACK_CHANNEL |
| Renaissance 7 | Neither (unassigned) | SLACK_FALLBACK_CHANNEL |
| Outlook 3 | Neither (unassigned) | SLACK_FALLBACK_CHANNEL |
| ERC 1, ERC 2 | Neither (unassigned) | SLACK_FALLBACK_CHANNEL |
| Section 125 1 | Workspace default | notifications-ido |
| Section 125 2 | Neither (unassigned) | SLACK_FALLBACK_CHANNEL |
| Warm Leads | Workspace default | notifications-ido |

### 2.6 Updating CM Assignments

When a workspace ownership changes (e.g., Renaissance 3 gets assigned to a CM), update `WORKSPACE_CONFIGS[n].defaultCm` and redeploy. No code changes required. This is a 1-line config edit.

---

## 3. Audit Log Dashboard (Feature 2.4)

### 3.1 What It Is

A lightweight HTML page served by the Cloudflare Worker at `/__dashboard`. It reads the KV audit log entries already written on every action and renders them grouped by date. No new data is stored — all entries are produced by the existing audit logging in `index.ts`.

The dashboard is on-demand (pull model), not a scheduled push. Sam and leadership load it when they want to review what the system has done.

### 3.2 KV Data Schema (Existing, from technical-design.md)

Each audit action is stored at key `log:{ISO timestamp}:{campaignId}:{stepIndex}:{variantIndex}` with a 90-day TTL:

```json
{
  "timestamp": "2026-03-15T14:00:03.412Z",
  "action": "DISABLED",
  "workspace": "The Gatekeepers",
  "workspaceId": "the-gatekeepers",
  "campaign": "Healthcare - Pair 8 - RG2118/RG2119/RG2120 (BRENDAN)",
  "campaignId": "abc123",
  "step": 2,
  "variant": 0,
  "variantLabel": "A",
  "cm": "BRENDAN",
  "trigger": {
    "sent": 9147,
    "opportunities": 1,
    "ratio": "9147.0",
    "threshold": 4000,
    "rule": "Ratio 9147.0:1 exceeds threshold 4000:1"
  },
  "safety": {
    "survivingVariants": 2,
    "notification": "none"
  },
  "dryRun": false
}
```

Run summaries are stored at key `run:{ISO timestamp}`:

```json
{
  "timestamp": "2026-03-15T14:00:17.267Z",
  "workspacesProcessed": 13,
  "campaignsEvaluated": 236,
  "variantsDisabled": 5,
  "variantsBlocked": 12,
  "errors": 0,
  "durationMs": 17267,
  "dryRun": false
}
```

### 3.3 URL and Auth

**URL:** `https://auto-turnoff.{account}.workers.dev/__dashboard`

No authentication in v2. The Worker URL is not published or linked anywhere, making it discoverable only to someone who already has access to the Cloudflare account or has been given the URL directly. If external exposure becomes a concern in v3+, add a `?token=` query parameter check against a KV-stored secret.

### 3.4 Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `date` | Today (UTC) | Date to display: `YYYY-MM-DD` format |
| `type` | `all` | Filter by action type: `DISABLED`, `BLOCKED`, or `all` |
| `days` | — | If provided, show a summary roll-up for the last N days instead of the per-action table |

Examples:
- `/__dashboard` — today's actions, all types
- `/__dashboard?date=2026-03-14` — yesterday's actions
- `/__dashboard?type=BLOCKED` — today's blocked-only (last variant prevented from disable)
- `/__dashboard?days=7` — 7-day roll-up with daily counts

### 3.5 Fetch Handler Integration

The Worker's `fetch` handler in `index.ts` currently does not serve HTTP requests. Update the default export:

```typescript
import { serveDashboard } from './dashboard';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // ... existing cron handler unchanged ...
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__scheduled') {
      // Manual trigger for testing (dry-run only; add DRY_RUN check if needed)
      ctx.waitUntil(runAutoTurnOff(env));
      return new Response('Triggered', { status: 200 });
    }

    if (url.pathname === '/__dashboard') {
      return serveDashboard(env.KV, url.searchParams);
    }

    return new Response('Auto Turn-Off Worker v2', { status: 200 });
  },
};
```

### 3.6 New File: `src/dashboard.ts`

```typescript
export async function serveDashboard(
  kv: KVNamespace,
  params: URLSearchParams
): Promise<Response> {
  const dateParam = params.get('date') ?? todayUtc();
  const typeFilter = params.get('type') ?? 'all';
  const daysParam = params.get('days');

  if (daysParam !== null) {
    return serveSummaryView(kv, parseInt(daysParam, 10));
  }

  return serveDateView(kv, dateParam, typeFilter);
}
```

**Date view — loading entries:**

```typescript
async function serveDateView(
  kv: KVNamespace,
  date: string,
  typeFilter: string
): Promise<Response> {
  // List all log keys for the given date
  const prefix = `log:${date}`;
  const listed = await kv.list({ prefix });

  // Fetch each entry
  const entries: AuditEntry[] = [];
  for (const key of listed.keys) {
    const raw = await kv.get(key.name);
    if (raw) {
      const entry = JSON.parse(raw) as AuditEntry;
      if (typeFilter === 'all' || entry.action === typeFilter) {
        entries.push(entry);
      }
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Load run summaries for this date
  const runListed = await kv.list({ prefix: `run:${date}` });
  const runs: RunSummary[] = [];
  for (const key of runListed.keys) {
    const raw = await kv.get(key.name);
    if (raw) runs.push(JSON.parse(raw) as RunSummary);
  }
  runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const html = renderDateView(date, entries, runs, typeFilter);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

**KV list pagination note:** `kv.list()` returns up to 1,000 keys per call. At ~200 audit actions per day maximum (capped by campaign count and kill frequency), a single call is sufficient for the date view. The `listed.list_complete` boolean indicates whether pagination is needed — check it and log a warning if `list_complete === false`:

```typescript
if (!listed.list_complete) {
  console.warn(`[dashboard] KV list incomplete for prefix "${prefix}" — pagination needed`);
}
```

**Summary view — last N days:**

```typescript
async function serveSummaryView(kv: KVNamespace, days: number): Promise<Response> {
  const rows: DaySummary[] = [];

  for (let i = 0; i < days; i++) {
    const date = dateUtcMinusDays(i);
    const listed = await kv.list({ prefix: `run:${date}` });

    let disabled = 0, blocked = 0, errors = 0, runsCompleted = 0;
    for (const key of listed.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      const run = JSON.parse(raw) as RunSummary;
      disabled += run.variantsDisabled;
      blocked += run.variantsBlocked;
      errors += run.errors;
      runsCompleted++;
    }

    rows.push({ date, disabled, blocked, errors, runsCompleted });
  }

  const html = renderSummaryView(rows, days);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

### 3.7 HTML Structure

The HTML is generated inline as a template string — no external CSS, no JavaScript dependencies. Dark mode, minimal styling.

**Date view layout:**

```
[Header]
Auto Turn-Off Audit Log
[Date picker: prev | 2026-03-15 | next]  [Filter: all | DISABLED | BLOCKED]

[Run Summary Cards — one per cron run that day]
  Run 14:00 UTC  |  13 workspaces  |  236 campaigns  |  5 disabled  |  12 blocked  |  0 errors  |  17.3s

[Action Table]
  Time     | Action   | Workspace       | Campaign                        | Step | Var | Sent   | Opps | Ratio   | CM
  14:00:03 | DISABLED | The Gatekeepers | Healthcare - Pair 8 (BRENDAN)   |  3   |  A  | 9,147  |  1   | 9147:1  | BRENDAN
  14:00:05 | BLOCKED  | Outlook 1       | Construction 2 - Outlook        |  1   |  B  | 5,200  |  0   | inf     | IDO
```

**Color coding:**
- `DISABLED` row: subtle red background (`#3d1515`)
- `BLOCKED` row: subtle amber background (`#3d2d0a`)
- `dryRun: true` entries: italic text, muted opacity

**Navigation:**
- Prev/next day links: `?date=YYYY-MM-DD` with date arithmetic in the render function
- Filter tabs rendered as links: `?date={date}&type=all`, `?date={date}&type=DISABLED`, `?date={date}&type=BLOCKED`
- "Last 7 days" link: `?days=7`

**Summary view layout:**

```
[Header]
Auto Turn-Off — Last 7 Days

  Date        | Runs | Disabled | Blocked | Errors
  2026-03-15  |  24  |    5     |   12    |   0     [link to date view]
  2026-03-14  |  24  |    8     |    9    |   1     [link to date view]
  ...
```

### 3.8 Helper Types for Dashboard

Add to `types.ts`:

```typescript
export interface AuditEntry {
  timestamp: string;
  action: 'DISABLED' | 'BLOCKED';
  workspace: string;
  workspaceId: string;
  campaign: string;
  campaignId: string;
  step: number;
  variant: number;
  variantLabel: string;
  cm: string | null;
  trigger: {
    sent: number;
    opportunities: number;
    ratio: string;
    threshold: number;
    rule: string;
  };
  safety: {
    survivingVariants: number;
    notification: string;
  };
  dryRun: boolean;
}

export interface RunSummary {
  timestamp: string;
  workspacesProcessed: number;
  campaignsEvaluated: number;
  variantsDisabled: number;
  variantsBlocked: number;
  errors: number;
  durationMs: number;
  dryRun: boolean;
}

export interface DaySummary {
  date: string;
  disabled: number;
  blocked: number;
  errors: number;
  runsCompleted: number;
}
```

### 3.9 Performance Characteristics

| Operation | KV calls | Notes |
|-----------|----------|-------|
| Date view (date + type filter) | 1 list + N gets | N = actions that day, typically <100 |
| Summary view (7 days) | 7 lists + M gets | M = run summaries (24/day), so up to 168 gets |
| KV read cost | $0.50/million | Negligible — dashboard is low-frequency human use |

The summary view (7 days) makes up to 7 list calls and 168 get calls. At human access frequency (a few loads per day), this is immaterial. If the dashboard gets high-traffic access (unlikely for an internal tool), cache the summary in KV with a short TTL.

---

## 4. File Change Summary

| File | Change Type | What Changes |
|------|-------------|-------------|
| `src/config.ts` | Replace + extend | Remove `FUNDING_WORKSPACE_NAMES`, add `WorkspaceConfig` interface, `WORKSPACE_CONFIGS` array, `getWorkspaceConfig()` |
| `src/parser.ts` | Extend | Add `resolveCmChannel()`, `resolveCmName()` — existing `parseCmChannel()` and `parseCmName()` unchanged |
| `src/index.ts` | Update | Replace name-based filter with ID-based filter + validation; add ID mismatch warning; replace `parseCmChannel()` calls with `resolveCmChannel()`; add `fetch` handler routing to `/__dashboard` |
| `src/types.ts` | Extend | Add `AuditEntry`, `RunSummary`, `DaySummary` interfaces |
| `src/dashboard.ts` | New file | `serveDashboard()` + `serveDateView()` + `serveSummaryView()` + render functions |

No changes to `evaluator.ts`, `slack.ts`, `mcp-client.ts`, or `instantly.ts`.

---

## 5. Open Items

| Item | Owner | Status |
|------|-------|--------|
| Confirm exact workspace ID slugs for all 21 workspaces against a full `list_workspaces` response | Sam | Open |
| Confirm Renaissance 3, 6, 7 and Outlook 3 have no CM assignment in Inbox Hub (currently 100% unassigned per sheet analysis) | Sam / Samuel | Open |
| Decide whether Section 125 2 gets a CM assignment or stays as fallback channel | Sam / Ido | Open |
| Confirm `defaultCm: 'IDO'` for Warm Leads is correct — Ido manages all 6 tags per Inbox Hub | Sam | Open — sheet confirms |
| Set `SLACK_FALLBACK_CHANNEL` to a real channel ID before deploying v2 live (prerequisite from v1) | Sam / Darcy | Open (prerequisite) |
