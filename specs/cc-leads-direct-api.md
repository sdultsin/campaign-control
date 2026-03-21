# CC Revision Spec: Leads Monitoring — Direct API (Remove MCP Dependency)

**Date:** 2026-03-20
**Severity:** High (caused worker crash + stale lock on 2026-03-20 6am run)
**Scope:** `instantly-direct.ts`, `index.ts` (leads phase + MCP setup), `types.ts`
**CC-Review:** required before deploy

## What Went Wrong

The 2026-03-20 6am cron run crashed before writing `run_summary`, `daily_snapshot`, or releasing the KV lock. The stale lock blocked subsequent runs until manually cleared.

The cause: the leads check phase (Phase 3) makes two MCP calls per candidate campaign — `countLeads` and `getCampaignAnalytics` — routed through the Railway-hosted SSE transport. With even a small number of candidates, the serialized MCP calls consumed enough wall-clock time to hit Cloudflare's worker execution limit. The worker was hard-killed mid-Phase-3, before any end-of-run writes could execute.

`leadsChecked` was 0 in the last recoverable run summary. The lock sat in KV for hours.

## Why It Went Wrong

The leads phase was built on MCP because `countLeads` assumed there was no direct REST endpoint for lead counts. That assumption was never verified against what `GET /api/v2/campaigns/analytics` actually returns.

It returns `leads_count` — the same number MCP's `count_leads` tool returns as `total_leads` — along with `contacted_count`, `completed_count`, `bounced_count`, and `unsubscribed_count`. All fields needed for the depletion decision and audit log are already present on an endpoint the direct client already calls (for `contacted_count` during Phase 1).

The batch form of this endpoint — called without a campaign `id` parameter — returns all campaigns for the workspace in a single response, enabling O(1) lookups per workspace instead of O(N) serial MCP calls.

## What Needs to Be Fixed

### 1. `instantly-direct.ts` — Extend `getCampaignAnalytics()` to support batch mode and return lead fields

**Current signature:**
```typescript
async getCampaignAnalytics(workspaceId: string, campaignId: string): Promise<{
  contacted: number; sent: number;
}>
```

**New signature:**
```typescript
async getCampaignAnalytics(workspaceId: string, campaignId?: string): Promise<{
  contacted: number;
  sent: number;
  leads_count: number;
  completed_count: number;
  bounced_count: number;
  unsubscribed_count: number;
}>
```

**Behavior changes:**
- When `campaignId` is provided: call `GET /campaigns/{campaignId}/analytics` (existing per-campaign path, used in Phase 1)
- When `campaignId` is omitted: call `GET /api/v2/campaigns/analytics` with no `id` param — returns all campaigns for the workspace
- In both cases, extract and return: `leads_count`, `contacted_count` (mapped to `contacted`), `completed_count`, `bounced_count`, `unsubscribed_count`
- **Do NOT pass `exclude_total_leads_count=true`** — that parameter zeros out `leads_count`

**Batch response shape** (no `id` param): returns `{ campaigns: [{id, leads_count, contacted_count, completed_count, bounced_count, unsubscribed_count, ...}] }`. Return type for the batch overload should be `Map<string, {...}>` (keyed by campaign ID) or a separate method. See implementation note below.

**Implementation note — cleanest approach:** Add a new dedicated method rather than overloading the existing one, to avoid changing Phase 1 call sites:

```typescript
/**
 * Batch fetch campaign analytics for all campaigns in a workspace.
 * Returns a Map<campaignId, analytics> for O(1) lookups.
 * ONE call per workspace — replaces N serial MCP calls.
 */
async getBatchCampaignAnalytics(workspaceId: string): Promise<Map<string, {
  leads_count: number;
  contacted: number;
  completed_count: number;
  bounced_count: number;
  unsubscribed_count: number;
}>>
```

Call: `GET /api/v2/campaigns/analytics` with no `id` param. Parse `campaigns` array and build the Map. The existing `getCampaignAnalytics(workspaceId, campaignId)` stays unchanged for Phase 1.

**Field mapping from API response:**

| API field | Map to |
|-----------|--------|
| `leads_count` | `leads_count` |
| `contacted_count` | `contacted` |
| `completed_count` | `completed_count` |
| `bounced_count` | `bounced_count` |
| `unsubscribed_count` | `unsubscribed_count` |

**Note on the existing `countLeads()` method in `instantly-direct.ts`:** This method (lines 129-156) was a placeholder that returned zeros. It can be left in place — it is no longer called from `index.ts` after this change. Do not delete it.

---

### 2. `index.ts` — Rework leads phase to use batch direct API

#### 2a. Remove MCP-always-needed setup (lines 372-381)

**Before:**
```typescript
// API client: direct mode bypasses MCP for fast endpoints (50x faster).
// MCP is always created because leads count has no direct API endpoint.
const useDirectApi = env.INSTANTLY_MODE === 'direct' && env.INSTANTLY_API_KEYS;
const mcp = new McpClient();
const mcpApi = new InstantlyApi(mcp);
const instantly = useDirectApi
  ? new InstantlyDirectApi(env.INSTANTLY_API_KEYS)
  : mcpApi;
// For leads check: always use MCP (Instantly has no direct /leads/count endpoint)
const leadsApi = mcpApi;
```

**After:**
```typescript
const useDirectApi = env.INSTANTLY_MODE === 'direct' && env.INSTANTLY_API_KEYS;
const mcp = new McpClient();
const mcpApi = new InstantlyApi(mcp);
const instantly = useDirectApi
  ? new InstantlyDirectApi(env.INSTANTLY_API_KEYS)
  : mcpApi;
// leadsApi removed — leads now use batch direct API (getBatchCampaignAnalytics)
```

Remove the `const leadsApi = mcpApi;` line and its comment entirely.

#### 2b. Remove the MCP `connect()` "always needed" comment (line ~430)

**Before:**
```typescript
// 2. CONNECT MCP (always needed -- leads check uses MCP even in direct mode)
await mcp.connect();
```

**After:**
```typescript
// 2. CONNECT MCP (used when INSTANTLY_MODE=mcp; skipped in direct mode)
if (!useDirectApi) {
  await mcp.connect();
}
```

Or, if the MCP connect is needed anyway for other reasons (e.g., Phase 1 in non-direct mode), simply update the comment. The key requirement: MCP connection must NOT be treated as always-required due to leads.

#### 2c. Remove the MCP reconnection block before Phase 3 (lines 1456-1466)

**Remove this block entirely:**
```typescript
// Reconnect MCP if using direct mode (SSE may have dropped during Phase 1)
if (useDirectApi && leadsCheckCandidates.length > 0) {
  try {
    await mcp.close().catch(() => {});
    await mcp.connect();
    console.log(`[auto-turnoff] MCP reconnected for leads check`);
  } catch (reconnErr) {
    console.error(`[auto-turnoff] MCP reconnect failed — leads check will be skipped: ${reconnErr}`);
    totalErrors++;
  }
}
```

This reconnection block was the direct enabler of the crash. After removing it and switching leads to direct API, there is no SSE dependency in Phase 3.

#### 2d. Replace the per-candidate dual MCP calls with batch lookup (lines 1447-1480)

**Before (inside the `for (const candidate of leadsCheckCandidates)` loop):**
```typescript
// Fetch lead counts + campaign analytics via MCP (no direct API endpoint for leads)
const [leadCounts, campaignAnalytics] = await Promise.all([
  leadsApi.countLeads(candidate.workspaceId, candidate.campaignId),
  leadsApi.getCampaignAnalytics(candidate.workspaceId, candidate.campaignId),
]);
const totalLeads = leadCounts.total_leads;
const { completed, active, bounced, skipped, unsubscribed } = leadCounts.status;
const { contacted } = campaignAnalytics;
```

**After — fetch batch maps per workspace before the loop, then look up inside:**

Before the `for (const candidate of leadsCheckCandidates)` loop, group candidates by workspace and fetch one batch per workspace:

```typescript
// Batch fetch analytics for all workspaces represented in the candidate list
const workspaceIds = [...new Set(leadsCheckCandidates.map((c) => c.workspaceId))];
const batchByWorkspace = new Map<string, Map<string, {
  leads_count: number; contacted: number; completed_count: number;
  bounced_count: number; unsubscribed_count: number;
}>>();

if (useDirectApi) {
  const directApi = instantly as InstantlyDirectApi;
  for (const wsId of workspaceIds) {
    try {
      const batchMap = await directApi.getBatchCampaignAnalytics(wsId);
      batchByWorkspace.set(wsId, batchMap);
    } catch (batchErr) {
      console.error(`[auto-turnoff] Batch analytics fetch failed for workspace ${wsId}: ${batchErr}`);
      totalErrors++;
    }
  }
}
```

Then inside the `for (const candidate of leadsCheckCandidates)` loop, replace the dual MCP calls:

```typescript
let totalLeads: number;
let contacted: number;
let completed: number;
let bounced: number;
let unsubscribed: number;

if (useDirectApi) {
  const wsMap = batchByWorkspace.get(candidate.workspaceId);
  const data = wsMap?.get(candidate.campaignId);
  if (!data) {
    console.warn(`[auto-turnoff] No batch analytics for campaign ${candidate.campaignId} — skipping`);
    continue;
  }
  totalLeads = data.leads_count;
  contacted = data.contacted;
  completed = data.completed_count;
  bounced = data.bounced_count;
  unsubscribed = data.unsubscribed_count;
} else {
  // MCP fallback path (non-direct mode)
  const [leadCounts, campaignAnalytics] = await Promise.all([
    mcpApi.countLeads(candidate.workspaceId, candidate.campaignId),
    mcpApi.getCampaignAnalytics(candidate.workspaceId, candidate.campaignId),
  ]);
  totalLeads = leadCounts.total_leads;
  const s = leadCounts.status;
  contacted = campaignAnalytics.contacted;
  completed = s.completed;
  bounced = s.bounced;
  unsubscribed = s.unsubscribed;
}
```

#### 2e. Update `LeadsAuditEntry` construction (3 sites: EXHAUSTED, WARNING, RECOVERED)

`active` and `skipped` are not available from the batch endpoint. Update all three audit entry constructions:

**Before:**
```typescript
leads: {
  total: totalLeads,
  contacted,
  uncontacted: 0,       // or: uncontacted
  completed,
  active,               // from leadCounts.status.active
  bounced,
  skipped,              // from leadCounts.status.skipped
  unsubscribed,
  dailyLimit: candidate.dailyLimit,
},
```

**After:**
```typescript
leads: {
  total: totalLeads,
  contacted,
  uncontacted: 0,       // or: uncontacted (varies by action type)
  completed,
  active: totalLeads - completed,   // approximation; audit-log-only, not used for decisions
  bounced,
  skipped: 0,           // not available from analytics endpoint; audit-log-only
  unsubscribed,
  dailyLimit: candidate.dailyLimit,
},
```

Apply to all three `LeadsAuditEntry` constructions: LEADS_EXHAUSTED (~line 1519), LEADS_WARNING (~line 1613), LEADS_RECOVERED (~line 1689).

#### 2f. Update MCP close comment (line ~1952)

**Before:**
```typescript
// CLOSE MCP (always created -- used for leads check even in direct mode)
await mcp.close().catch(...)
```

**After:**
```typescript
// CLOSE MCP (no-op if never connected)
await mcp.close().catch(...)
```

---

### 3. `leads-monitor.ts` — No changes

`computeUncontacted(totalLeads, contacted)` and `evaluateLeadDepletion()` are source-agnostic pure functions. No changes needed.

---

### 4. `instantly.ts` (MCP client) — No changes

Keep `countLeads()` and `getCampaignAnalytics()` in place. After this change, they are only called from `index.ts` in the MCP fallback path (non-direct mode). Do not delete.

---

### 5. `types.ts` — Make `active` and `skipped` optional in `LeadsAuditEntry`

**Before:**
```typescript
export interface LeadsAuditEntry {
  ...
  leads: {
    total: number;
    contacted: number;
    uncontacted: number;
    completed: number;
    active: number;
    bounced: number;
    skipped: number;
    unsubscribed: number;
    dailyLimit: number;
  };
  ...
}
```

**After:**
```typescript
export interface LeadsAuditEntry {
  ...
  leads: {
    total: number;
    contacted: number;
    uncontacted: number;
    completed: number;
    /** Approximated as total - completed when using direct API (analytics endpoint does not return per-status lead counts) */
    active: number;
    bounced: number;
    /** Not available from analytics endpoint; set to 0 when using direct API */
    skipped: number;
    unsubscribed: number;
    dailyLimit: number;
  };
  ...
}
```

The fields stay required (set to derived values or 0) to avoid breaking Supabase writes. Add JSDoc comments to document the approximation.

---

## Risk Considerations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `bounced_count` from analytics endpoint = email bounces, not lead-status bounces | Audit log only, no effect on EXHAUSTED/WARNING decision | Document in JSDoc; field renamed to `bounced_count` to distinguish |
| `skipped` not available | Audit log shows `0` instead of accurate count | Acceptable — `skipped` was never used for depletion logic |
| `active` approximated as `total - completed` | Audit log only, no effect on decision | Document in JSDoc |
| Batch call returns all campaigns (including paused/finished) | Extra data in Map | Filter by `candidate.campaignId` on lookup — only candidates are evaluated |
| `leads_count = 0` for new/empty campaigns | `evaluateLeadDepletion` returns SKIPPED when `totalLeads <= 0` | Already handled — no change needed |
| Non-direct mode (MCP) still works | MCP fallback path preserved | Both paths coexist; direct mode is production |

## What NOT to Change

- `leads-monitor.ts` — pure functions, source-agnostic
- KV dedup keys `leads-exhausted:` and `leads-warning:` — unchanged
- Slack notification format for leads alerts — unchanged
- Leads candidate selection logic (which campaigns enter Phase 3) — unchanged
- `LeadsCheckCandidate` type — unchanged
- Supabase `leads_audit_logs` table schema — unchanged
- KV dedup keys for variant kill/warning/rescan — unrelated, unchanged

## Migration

No Supabase schema changes needed. The `leads_audit_logs.leads` JSONB column continues to receive all the same fields. `skipped` will be `0` going forward instead of an accurate count. This is acceptable — `skipped` was never used for any decision and is not displayed in Slack notifications.

No KV key changes. No wrangler.toml changes.

## Change Summary

| File | Changes |
|------|---------|
| `instantly-direct.ts` | Add `getBatchCampaignAnalytics()` method |
| `index.ts` | Remove `leadsApi` assignment; conditionalize MCP connect; remove MCP reconnect block; replace dual MCP calls with batch lookup + MCP fallback; update 3 audit entry constructions; update MCP close comment |
| `types.ts` | Add JSDoc to `active` and `skipped` fields in `LeadsAuditEntry` |
| `leads-monitor.ts` | None |
| `instantly.ts` | None |
| `supabase.ts` | None |
| `slack.ts` | None |

## Verification

After deploying:

1. **Run summary:** `leadsChecked` should be > 0 (was 0 when MCP failed mid-run)
2. **Audit logs:** `leads_audit_logs` entries should have `total`, `contacted`, `completed`, `bounced`, `unsubscribed` populated with real numbers; `skipped` = 0
3. **Duration:** `duration_ms` in run summary should be well under 300,000ms — no more MCP slowdown in Phase 3
4. **Lock cleared:** KV lock released at end of run (no stale lock after cron completes)
5. **End-of-run writes:** Both `run_summary` KV + Supabase and `daily_snapshot` written — no more crash before end-of-run
6. **MCP connect logs:** In direct mode, no "MCP reconnected for leads check" log line should appear

## Execution Instructions

1. Use `/technical` persona to implement
2. Run `npx tsc --noEmit` to verify compilation
3. Run `/cc-review` before deploying — all 8 checklist items must pass
4. Deploy with `npx wrangler deploy`
5. Check Cloudflare Worker logs on next cron run to confirm no Phase 3 MCP calls
