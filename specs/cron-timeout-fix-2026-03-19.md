# Campaign Control V2: Cron Timeout Fix

**Date:** 2026-03-19
**Status:** Draft (DO NOT DEPLOY without review)

---

## Root Cause Analysis

### Primary Cause: Cloudflare Cron CPU Time Limit

Cloudflare Workers on the **Standard plan** give cron triggers **30 seconds of CPU time**. This is NOT wall-clock time -- it's actual CPU execution time. However, the critical nuance is how Cloudflare measures this:

- **I/O wait (fetch, KV reads)** does NOT count toward CPU time on the Standard plan
- **BUT** the worker runtime has a **wall-clock timeout for cron triggers** that varies by plan:
  - Free plan: 30s wall-clock
  - Standard plan (Workers Standard): **15 minutes wall-clock** for `scheduled()` handlers
  - BUT there's a catch: the 15-minute limit applies only when using `ctx.waitUntil()`. Without it, the runtime may terminate the handler much earlier.

**The `scheduled()` handler in index.ts ignores the `ExecutionContext` parameter entirely.** The parameter is `_ctx` (underscore-prefixed, intentionally unused), and `ctx.waitUntil()` is never called anywhere in the codebase. This means:

1. The `scheduled()` function returns a Promise
2. Cloudflare's runtime awaits that Promise
3. But without `ctx.waitUntil()`, the runtime has no guarantee the work needs extended time
4. The runtime may terminate the worker after the default response timeout window

### Why Local Works, Cron Doesn't

`wrangler dev` runs locally with no timeout enforcement. The `/__scheduled` HTTP endpoint also bypasses cron-specific limits because it runs as a fetch handler. In production, the cron trigger is subject to the platform's scheduled handler lifetime limits.

### Secondary Cause: MCP Round-Trip Latency Makes the Run Take 15 Minutes

Each MCP call follows this path:
```
Worker (CF Edge) -> Railway SSE -> Instantly API -> Railway -> Worker
```

Per campaign, the worker makes 3-5 MCP calls (getCampaigns, getCampaignDetails, getStepAnalytics, resolveThreshold with listAccounts + getAccount). With 65 campaigns across 18 workspaces, concurrency capped at 5, and each MCP round-trip averaging 2-10 seconds:

- V1 made direct API calls: ~0.3s per campaign = ~50s total
- V2 routes through MCP: ~14s per campaign = ~900s (15 min) total

The 50x slowdown makes V2 fundamentally incompatible with any reasonable timeout.

### Tertiary Cause: KV is Empty

The `clearV1Keys()` function (line 109) deletes all keys with prefixes `kill:`, `blocked:`, `warning:`, `rescan:`. This endpoint is accessible via `/__clear-v1-keys`. If someone hit this endpoint (or it was called during deployment testing), it would wipe all operational KV data. The function doesn't have any confirmation gate or logging of what it deleted.

Additionally, since cron runs die before reaching the end-of-run KV writes (lines 1765-1806), no `run:` or `snapshot:` keys are ever created from cron runs. Only successful local test runs would write them, and those happened only today.

### Additional Issue: Fire-and-Forget Supabase/KV Writes

Throughout the evaluation loop, many Supabase writes use `.catch()` without `await`:
```typescript
if (sb) writeAuditLogToSupabase(sb, auditEntry).catch(...);  // No await!
if (sb) writeNotificationToSupabase(sb, {...}).catch(...);     // No await!
```

When the worker dies mid-run, these in-flight promises are abandoned. This explains why some audit_logs make it to Supabase (the ones that completed before termination) while others don't.

### Slack sleep() Compounds the Problem

Each Slack notification calls `postThreadedMessage()` which has:
- `await sleep(500)` between title and detail messages
- `await sleep(1000)` after the detail message

For 22 Slack API calls, that's ~33 seconds of pure sleeping. Combined with actual API latency, Slack alone burns ~60-90 seconds of wall-clock time.

---

## Fix Plan

### Fix 1: Eliminate MCP Bottleneck (THE Critical Fix)

**Problem:** Every API call goes Worker -> Railway MCP SSE -> Instantly API -> Railway -> Worker. This is the single reason V2 takes 15 minutes instead of 50 seconds.

**Solution:** Add a direct Instantly API client that bypasses MCP entirely. The MCP server is just a wrapper around the Instantly REST API. The worker should call Instantly directly using the API key stored as a secret.

**Implementation:**

Create `src/instantly-direct.ts` implementing the same interface as `InstantlyApi`:

```typescript
import type { Workspace, Campaign, CampaignDetail, StepAnalytics } from './types';

export class InstantlyDirectApi {
  private apiKey: string;
  private baseUrl = 'https://api.instantly.ai/api/v2';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Instantly API ${res.status}: ${path} - ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Instantly API PATCH ${res.status}: ${path} - ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // NOTE: Workspace context is set via ?workspace_id= parameter on V2 endpoints.
  // A single org API key works across all workspaces.

  async listWorkspaces(): Promise<Workspace[]> {
    // GET /api/v2/workspaces
    const raw = await this.get<{ items?: Workspace[] } | Workspace[]>('/workspaces');
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  }

  async getCampaigns(workspaceId: string): Promise<Campaign[]> {
    // GET /api/v2/campaigns?workspace_id=X&status=active&limit=100
    const raw = await this.get<{ items?: Campaign[] } | Campaign[]>('/campaigns', {
      workspace_id: workspaceId,
      status: 'active',
      limit: '100',
    });
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  }

  async getCampaignDetails(workspaceId: string, campaignId: string): Promise<CampaignDetail> {
    // GET /api/v2/campaigns/{id}?workspace_id=X
    return this.get<CampaignDetail>(`/campaigns/${campaignId}`, {
      workspace_id: workspaceId,
    });
  }

  async getStepAnalytics(workspaceId: string, campaignId: string): Promise<StepAnalytics[]> {
    // GET /api/v2/campaigns/analytics/steps?campaign_id=X&include_opportunities_count=true
    const raw = await this.get<StepAnalytics[] | { data?: StepAnalytics[] }>(
      '/campaigns/analytics/steps',
      {
        workspace_id: workspaceId,
        campaign_id: campaignId,
        include_opportunities_count: 'true',
      },
    );
    return Array.isArray(raw) ? raw : (raw.data ?? []);
  }

  async countLeads(workspaceId: string, campaignId: string): Promise<{
    total_leads: number;
    status: { completed: number; active: number; skipped: number; bounced: number; unsubscribed: number };
  }> {
    const raw = await this.get<Record<string, unknown>>('/leads/count', {
      workspace_id: workspaceId,
      campaign_id: campaignId,
    });
    const status = (raw.status as Record<string, number>) ?? {};
    return {
      total_leads: (raw.total_leads as number) ?? 0,
      status: {
        completed: status.completed ?? 0,
        active: status.active ?? 0,
        skipped: status.skipped ?? 0,
        bounced: status.bounced ?? 0,
        unsubscribed: status.unsubscribed ?? 0,
      },
    };
  }

  async getCampaignAnalytics(workspaceId: string, campaignId: string): Promise<{
    contacted: number; sent: number;
  }> {
    const raw = await this.get<Record<string, unknown>>(`/campaigns/${campaignId}/analytics`, {
      workspace_id: workspaceId,
    });
    if (Array.isArray((raw as any).campaigns) && (raw as any).campaigns.length > 0) {
      const c = (raw as any).campaigns[0];
      return { contacted: c.contacted ?? 0, sent: c.sent ?? 0 };
    }
    return { contacted: (raw.contacted as number) ?? 0, sent: (raw.sent as number) ?? 0 };
  }

  async listAccounts(workspaceId: string, tagIds: string): Promise<Array<{
    email?: string; provider_code?: number; [key: string]: unknown;
  }>> {
    const raw = await this.get<unknown>('/accounts', {
      workspace_id: workspaceId,
      tag_ids: tagIds,
    });
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      for (const val of Object.values(raw as Record<string, unknown>)) {
        if (Array.isArray(val)) return val;
      }
    }
    return [];
  }

  async getAccount(workspaceId: string, email: string): Promise<{
    provider_code?: number; [key: string]: unknown;
  }> {
    const raw = await this.get<Record<string, unknown>>(`/accounts/${encodeURIComponent(email)}`, {
      workspace_id: workspaceId,
    });
    if ('account' in raw) return raw.account as any;
    return raw;
  }

  async enableVariant(
    workspaceId: string,
    campaign: CampaignDetail,
    stepIndex: number,
    variantIndex: number,
  ): Promise<boolean> {
    const cloned = structuredClone(campaign.sequences);
    cloned[0].steps[stepIndex].variants[variantIndex].v_disabled = false;

    await this.patch(`/campaigns/${campaign.id}`, {
      workspace_id: workspaceId,
      sequences: cloned,
    });

    const verified = await this.getCampaignDetails(workspaceId, campaign.id);
    return verified.sequences?.[0]?.steps?.[stepIndex]?.variants?.[variantIndex]?.v_disabled !== true;
  }

  async disableVariant(
    workspaceId: string,
    campaign: CampaignDetail,
    stepIndex: number,
    variantIndex: number,
  ): Promise<boolean> {
    const cloned = structuredClone(campaign.sequences);
    cloned[0].steps[stepIndex].variants[variantIndex].v_disabled = true;

    await this.patch(`/campaigns/${campaign.id}`, {
      workspace_id: workspaceId,
      sequences: cloned,
    });

    const verified = await this.getCampaignDetails(workspaceId, campaign.id);
    return verified.sequences?.[0]?.steps?.[stepIndex]?.variants?.[variantIndex]?.v_disabled === true;
  }
}
```

**IMPORTANT:** The exact response shapes for each endpoint must be verified against the real API before deployment. The MCP server may wrap/transform responses. Run one call per endpoint and compare to MCP output to confirm field names match.

**Expected impact:** Reduces per-campaign time from ~14s to ~1-2s. Full run: ~65-130s instead of 900s. Well within any Cloudflare timeout.

**New env var needed:** `INSTANTLY_API_KEY` as a Cloudflare secret.

**Migration path:** Keep `InstantlyApi` (MCP-based) as a fallback. Add `INSTANTLY_MODE` env var (`direct` | `mcp`) to switch between them. Both implement the same interface.

**Risk:** The MCP server may do data transformations or enrichment that direct API calls don't replicate. Need to compare MCP tool response shapes vs raw Instantly API response shapes for each endpoint used:
- `list_workspaces` -> GET /workspaces
- `get_campaigns` -> GET /campaigns
- `get_campaign_details` -> GET /campaigns/{id}
- `get_step_analytics` -> GET /campaigns/{id}/analytics/steps
- `list_accounts` -> GET /accounts
- `get_account` -> GET /accounts/{email}
- `update_campaign` -> PATCH /campaigns/{id}
- `count_leads` -> GET /leads/count
- `get_campaign_analytics` -> GET /campaigns/{id}/analytics

Before implementing, check the MCP server source or compare one response from each to verify field mapping.

### Fix 2: Use ctx.waitUntil() for Extended Execution

**Problem:** The `scheduled()` handler doesn't use `ctx.waitUntil()`, which may cause early termination.

**Solution:** Wrap the entire run in `ctx.waitUntil()`:

```typescript
async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // Wrap the entire run in waitUntil to ensure Cloudflare keeps the worker alive
  const runPromise = this.executeScheduledRun(env);
  ctx.waitUntil(runPromise);
  // Also await it so errors propagate
  await runPromise;
},

private async executeScheduledRun(env: Env): Promise<void> {
  // ... move all current scheduled() body here
}
```

**Note:** This alone won't fix the 15-minute MCP run (it still exceeds reasonable limits and wastes resources), but it ensures the runtime knows the worker needs extended execution time.

**Implementation detail:** Since this is an `export default` object, not a class, extract the body into a standalone `async function executeScheduledRun(env: Env)` and call it as:
```typescript
async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const promise = executeScheduledRun(env);
  ctx.waitUntil(promise);
  await promise;
},
```

### Fix 3: Await All In-Loop Writes

**Problem:** Supabase writes inside the evaluation loop are fire-and-forget (no `await`). When the worker dies, pending writes are lost.

**Solution:** Add `await` to all in-loop Supabase writes. There are approximately 15 instances of this pattern:

```typescript
// BEFORE (fire-and-forget):
if (sb) writeAuditLogToSupabase(sb, auditEntry).catch(...);
if (sb) writeNotificationToSupabase(sb, {...}).catch(...);

// AFTER (awaited):
if (sb) await writeAuditLogToSupabase(sb, auditEntry).catch(...);
if (sb) await writeNotificationToSupabase(sb, {...}).catch(...);
```

**Locations to fix** (all in index.ts):
- Line 645: deferred audit write
- Line 658: dry-run audit write
- Line 764: blocked audit write
- Line 782-799: blocked notification write
- Line 859: warning audit write
- Line 875-892: warning notification write
- Line 942: kill audit write
- Line 971-988: kill notification write
- Line 1111: expired audit write
- Line 1199-1200: CM override audit write
- Line 1301: re-enabled audit write
- Line 1243-1260: rescan notification write
- Line 1410: leads exhausted audit write
- Line 1425-1442: leads exhausted notification write
- Line 1504: leads warning audit write
- Line 1519-1536: leads warning notification write
- Line 1580: leads recovered audit write

**Performance impact:** Each Supabase write adds ~50-200ms. With ~20 writes per run, that's 1-4 seconds total. Negligible compared to MCP latency. With direct API calls (Fix 1), the total run time is still well under 3 minutes.

### Fix 4: Reduce Slack sleep() Times

**Problem:** Each `postThreadedMessage()` call sleeps 1.5 seconds total (500ms + 1000ms). With 22 notifications, that's 33 seconds of sleeping.

**Solution:** Reduce sleeps to the minimum needed for Slack ordering:

```typescript
// In slack.ts postThreadedMessage():
// BEFORE:
await sleep(500);   // between title and detail
await sleep(1000);  // after detail

// AFTER:
await sleep(200);   // 200ms is enough for Slack to process the thread
// Remove the post-detail sleep entirely (no ordering dependency)
```

**Expected savings:** ~28 seconds per run.

### Fix 5: Protect clearV1Keys Endpoint

**Problem:** `/__clear-v1-keys` wipes all operational KV data with no confirmation or logging.

**Solution:**
1. Add a required `confirm=yes` query parameter
2. Log what was deleted
3. Consider removing the endpoint entirely (it was meant for one-time V2 migration)

```typescript
if (url.pathname === '/__clear-v1-keys') {
  const confirm = url.searchParams.get('confirm');
  if (confirm !== 'yes') {
    return new Response('Add ?confirm=yes to actually clear keys. This is destructive.', { status: 400 });
  }
  return clearV1Keys(env);
}
```

Better yet, remove the endpoint entirely since the V1->V2 migration is complete.

### Fix 6: Add Observability (Progress Logging + Heartbeat)

**Problem:** When a cron run dies, there's no way to know where it died or why.

**Solution:** Add structured progress logging:

```typescript
// At the start of scheduled():
console.log(JSON.stringify({
  event: 'run_start',
  timestamp: new Date().toISOString(),
  dryRun: isDryRun,
  killsEnabled: env.KILLS_ENABLED === 'true',
}));

// After each workspace:
console.log(JSON.stringify({
  event: 'workspace_complete',
  workspace: workspace.name,
  campaignsEvaluated: /* count */,
  elapsedMs: Date.now() - runStart,
}));

// At each phase boundary:
console.log(JSON.stringify({
  event: 'phase_start',
  phase: 'rescan',
  elapsedMs: Date.now() - runStart,
}));
```

These structured logs can be captured with `wrangler tail --format json` and will show exactly where the worker dies.

Additionally, write a lightweight "heartbeat" to KV every N campaigns so we can verify KV writes are working at all in production:

```typescript
// Every 10 campaigns:
if (totalCampaignsEvaluated % 10 === 0) {
  await env.KV.put('heartbeat', JSON.stringify({
    timestamp: new Date().toISOString(),
    campaignsProcessed: totalCampaignsEvaluated,
  }), { expirationTtl: 3600 });
}
```

### Fix 7: Increase Concurrency for Direct API Mode

**Problem:** `CONCURRENCY_CAP = 5` was set conservatively for MCP (which shares a single SSE connection). With direct API calls, higher concurrency is safe.

**Solution:** When using direct API mode, increase default concurrency:

```typescript
const concurrencyCap = env.INSTANTLY_MODE === 'direct'
  ? Math.min(parseInt(env.CONCURRENCY_CAP, 10) || 10, 15)
  : Math.min(parseInt(env.CONCURRENCY_CAP, 10) || 3, 5);
```

With concurrency=10 and direct API calls (~300ms per call), the entire Phase 1 loop would complete in ~30-40 seconds.

---

## Implementation Priority

| Priority | Fix | Effort | Impact |
|----------|-----|--------|--------|
| **P0** | Fix 1: Direct API client | 3-4 hours | Reduces run from 900s to <120s. THE fix. |
| **P0** | Fix 2: ctx.waitUntil() | 5 minutes | Ensures runtime keeps worker alive |
| **P1** | Fix 3: Await in-loop writes | 30 minutes | Prevents data loss on early termination |
| **P1** | Fix 6: Observability | 30 minutes | Diagnose future failures |
| **P2** | Fix 4: Reduce Slack sleeps | 10 minutes | Saves 28 seconds |
| **P2** | Fix 5: Protect clearV1Keys | 5 minutes | Prevents accidental KV wipe |
| **P3** | Fix 7: Increase concurrency | 5 minutes | Further speedup with direct API |

---

## Verification Plan

### Before Deploying

1. **Verify Instantly API endpoints:** Make one direct API call for each endpoint used (list_workspaces, get_campaigns, etc.) and compare response shape to what the MCP tool returns. Document any field mapping differences.

2. **Add INSTANTLY_API_KEY secret:** `wrangler secret put INSTANTLY_API_KEY` with the Renaissance API key from Instantly.

3. **Local test with DRY_RUN=true:**
   ```bash
   cd /Users/sam/Documents/Claude Code/Renaissance/builds/auto-turn-off
   # Temporarily set DRY_RUN=true in wrangler.toml
   npx wrangler dev
   curl http://localhost:8787/__scheduled
   ```
   Verify: all 65 campaigns processed, run_summary written, daily_snapshot written, duration < 120s.

### After Deploying

1. **Tail production logs during next cron run:**
   ```bash
   npx wrangler tail auto-turnoff --format json
   ```
   Wait for the next cron trigger (check schedule: 10:00, 16:00, 22:00 UTC).

2. **Check Supabase for run_summary and daily_snapshot** after the cron run.

3. **Check KV for heartbeat key** to verify KV writes work in production.

4. **Compare Supabase data** from the cron run to a local test run to verify data accuracy.

---

## What NOT to Do

- **Do NOT add batching/chunking** (processing 10 campaigns per cron, continuing next cron). This adds complexity and breaks the daily snapshot (which needs all campaigns in one pass).
- **Do NOT add a Durable Object** to manage state across runs. Overkill for this problem.
- **Do NOT increase the cron frequency** to compensate for incomplete runs. Fix the root cause.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/instantly-direct.ts` | NEW FILE: Direct Instantly API client |
| `src/index.ts` | Use ctx.waitUntil(), swap to direct API, await in-loop writes, add observability |
| `src/slack.ts` | Reduce sleep times |
| `src/types.ts` | Add `INSTANTLY_API_KEY` and `INSTANTLY_MODE` to Env |
| `wrangler.toml` | Add `INSTANTLY_MODE = "direct"` var |
