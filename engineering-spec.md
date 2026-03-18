# Auto Turn-Off v1: Engineering Spec

**Created:** [2026-03-15]
**Purpose:** Complete build specification for a fresh Claude Code session to execute without questions.
**Build time estimate:** ~15-20 minutes with parallel agents.

---

## Required Reading (Load Order)

The executing session MUST read these files BEFORE building, in this order:

1. **This file** (`builds/auto-turn-off/engineering-spec.md`) - build instructions
2. **Technical design** (`builds/auto-turn-off/technical-design.md`) - engineering reasoning for every decision
3. **Phase 0 results** (`builds/auto-turn-off/phase-0-results.md`) - API validation evidence
4. **CM Slack mapping** (`builds/auto-turn-off/cm-slack-mapping.md`) - channel IDs and parser logic

Do NOT read: `vision.md` (superseded by this spec), `v1-spec.md` (product-level, not needed for build), any files outside `builds/auto-turn-off/`.

---

## Architecture Overview

```
[Cloudflare Worker Cron Trigger (hourly)]
    |
    v
[Orchestrator - index.ts]
    |
    +--> [MCP Client - mcp-client.ts] --> SSE/JSON-RPC --> [Railway MCP Server]
    |         |                                                    |
    |         v                                                    v
    |    [Instantly Layer - instantly.ts]                    [Instantly API]
    |
    +--> [Evaluator - evaluator.ts]  (pure logic: gate, evaluate, safety)
    |
    +--> [Parser - parser.ts]  (CM name extraction from campaign title)
    |
    +--> [Slack - slack.ts]  (notification formatting + delivery)
    |
    +--> [Cloudflare KV]  (run lock, CM channel map)
```

## File Structure

```
builds/auto-turn-off/
  src/
    index.ts          -- Cron handler, orchestrator, main loop
    mcp-client.ts     -- Generic MCP SSE + JSON-RPC client
    instantly.ts      -- Instantly-specific functions wrapping MCP calls
    evaluator.ts      -- Decision logic (gate, evaluate, safety check)
    parser.ts         -- CM name parser from campaign titles
    slack.ts          -- Slack notification formatting + delivery
    types.ts          -- TypeScript interfaces
    config.ts         -- Constants, workspace whitelist, CM channel map
  wrangler.toml       -- Cloudflare Worker + Cron config
  package.json
  tsconfig.json
```

---

## MCP Server Details (Verified 2026-03-15)

**URL:** `https://king-instantly-mcp-production.up.railway.app/sse`
**Transport:** SSE (Server-Sent Events)
**Auth:** None (open endpoint)
**Server:** `instantly-mcp v4.0.0`
**Protocol:** MCP over SSE with JSON-RPC 2.0

### Connection Protocol (tested and confirmed)

```
1. GET /sse with Accept: text/event-stream
   -> Server sends: event: endpoint\ndata: https://.../messages/{session-id}

2. POST to that endpoint URL with JSON-RPC:
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2024-11-05",
       "capabilities": {},
       "clientInfo": {"name": "auto-turnoff", "version": "1.0.0"}
     }
   }
   -> Response arrives on SSE stream as: data: {"jsonrpc":"2.0","id":1,"result":{...}}

3. POST notification (no id, no response expected):
   {"jsonrpc": "2.0", "method": "notifications/initialized"}

4. Now call tools via POST:
   {
     "jsonrpc": "2.0",
     "id": 2,
     "method": "tools/call",
     "params": {
       "name": "get_campaigns",
       "arguments": {"workspace_id": "...", "status": "active", "limit": 100}
     }
   }
   -> Response on SSE stream: data: {"jsonrpc":"2.0","id":2,"result":{...}}
```

**Critical:** The JSON-RPC method for calling tools is `tools/call` with `params.name` being the tool name and `params.arguments` being the tool parameters. NOT a direct method call like `get_campaigns`.

### Tool Schemas (Exact)

**list_workspaces** - no params
```json
{ "name": "list_workspaces", "arguments": {} }
```

**get_campaigns** - list campaigns from a workspace
```json
{
  "name": "get_campaigns",
  "arguments": {
    "workspace_id": "string (required)",
    "status": "active|paused|completed|draft|all",
    "limit": "number",
    "fetch_all": "boolean"
  }
}
```

**get_step_analytics** - per-variant analytics with opportunities
```json
{
  "name": "get_step_analytics",
  "arguments": {
    "workspace_id": "string (required)",
    "campaign_id": "string",
    "include_opportunities": true
  }
}
```
Note: param is `include_opportunities` (boolean), NOT `include_opportunities_count`.

**get_campaign_details** - full campaign with sequences array
```json
{
  "name": "get_campaign_details",
  "arguments": {
    "workspace_id": "string (required)",
    "campaign_id": "string (required)"
  }
}
```

**update_campaign** - update campaign (PATCH under the hood)
```json
{
  "name": "update_campaign",
  "arguments": {
    "workspace_id": "string (required)",
    "campaign_id": "string (required)",
    "updates": { "sequences": [...] }
  }
}
```
WARNING: `updates.sequences` replaces the ENTIRE sequences array. Always GET first, modify in-place, then update. See technical-design.md "PATCH Safety Model".

---

## Agent Build Plan

### Phase 1: Parallel (4 agents, no dependencies between them)

#### Agent A: Project Scaffolding + Types + Config
**Model:** sonnet
**Files to create:** `package.json`, `tsconfig.json`, `wrangler.toml`, `src/types.ts`, `src/config.ts`

**package.json:**
```json
{
  "name": "auto-turnoff",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250312.0",
    "typescript": "^5.7.0",
    "wrangler": "^4.0.0"
  }
}
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

**wrangler.toml:**
```toml
name = "auto-turnoff"
main = "src/index.ts"
compatibility_date = "2025-03-15"

[triggers]
crons = ["0 * * * *"]  # Every hour

[[kv_namespaces]]
binding = "KV"
id = "TO_BE_CREATED"
```
Note: KV namespace ID will be filled in after `wrangler kv namespace create KV`.

**src/types.ts** - Define all interfaces:

```typescript
// MCP response types
export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
}

// Instantly data types
export interface Workspace {
  id: string;
  name: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: string; // "active" | "paused" | "completed" | "draft"
}

export interface StepAnalytics {
  step: string;       // 0-indexed string: "0", "1", etc.
  variant: string;    // 0-indexed string: "0", "1", etc.
  sent: number;
  replies: number;
  unique_replies: number;
  opportunities: number;
  unique_opportunities: number;
}

export interface Variant {
  subject: string;
  body: string;
  v_disabled?: boolean;  // true = disabled, absent/false = active
  [key: string]: unknown;
}

export interface Step {
  type: string;
  delay: number;
  delay_unit: string;
  variants: Variant[];
  [key: string]: unknown;
}

export interface Sequence {
  steps: Step[];
  [key: string]: unknown;
}

export interface CampaignDetail {
  id: string;
  name: string;
  status: string;
  sequences: Sequence[];
  [key: string]: unknown;
}

// Decision types
export type DecisionAction = 'SKIP' | 'KEEP' | 'KILL_CANDIDATE';

export interface Decision {
  action: DecisionAction;
  reason: string;
}

export type NotificationType = 'LAST_VARIANT' | 'DOWN_TO_ONE' | null;

export interface SafetyResult {
  canKill: boolean;
  notify: NotificationType;
  remainingActive: number;
}

export interface KillAction {
  workspaceName: string;
  workspaceId: string;
  campaignId: string;
  campaignName: string;
  stepIndex: number;
  variantIndex: number;
  sent: number;
  opportunities: number;
  ratio: string;
  notification: NotificationType;
  survivingVariantCount: number;
}

// Environment bindings
export interface Env {
  KV: KVNamespace;
  DRY_RUN: string;           // "true" or "false"
  THRESHOLD: string;          // "4000"
  CONCURRENCY_CAP: string;    // "5"
  SLACK_BOT_TOKEN: string;    // "xoxb-..." (empty in dry-run)
  SLACK_FALLBACK_CHANNEL: string;
}
```

**src/config.ts** - Constants and mappings:

```typescript
export const MCP_SSE_URL = 'https://king-instantly-mcp-production.up.railway.app/sse';

// 13 Funding workspaces (names for logging, IDs fetched dynamically from MCP)
// The system fetches workspace list from MCP and filters to these names
export const FUNDING_WORKSPACE_NAMES = new Set([
  'Renaissance 1',
  'Renaissance 2',
  'Renaissance 4',
  'Renaissance 5',
  'The Eagles',
  'Equinox',
  'The Dyad',
  'The Gatekeepers',
  'Koi and Destroy',
  'Outlook 1',
  'Outlook 2',
  'Prospects Power',
  'Automated applications',
]);

// CM name -> Slack notification channel ID
export const CM_CHANNEL_MAP: Record<string, string> = {
  'EYVER': 'C0A7B19L932',
  'ANDRES': 'C0ADASDL7PH',
  'LEO': 'C0A618T6BF1',
  'CARLOS': 'C0A618X6ST1',
  'SAMUEL': 'C0A6EM740NA',
  'IDO': 'C0A6GNNG198',
  'ALEX': 'C0A8KUADR4Z',
  'MARCOS': 'C0AELJPTF4Y',
  'LAUTARO': 'C0A6GN95VS6',
  'BRENDAN': 'C0A619CL087',
  'TOMI': 'C0A618H43RV',
  'SHAAN': 'C0A6AAMFDNX',
};

// Variant index to letter label (for human-readable notifications)
export const VARIANT_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
```

---

#### Agent B: MCP Client
**Model:** sonnet
**Files to create:** `src/mcp-client.ts`

Build a reusable MCP client that handles the SSE transport protocol. This is the I/O foundation for all Instantly API calls.

**Requirements:**
- Connect to SSE endpoint, parse the `endpoint` event to get the POST URL
- Perform the initialize handshake (initialize -> notifications/initialized)
- Provide a `callTool(name, arguments)` method that:
  - Sends a `tools/call` JSON-RPC request via POST
  - Reads the SSE stream for the matching response (match by `id`)
  - Parses the response content (MCP returns `content: [{type: "text", text: "..."}]` where text is JSON)
  - Returns parsed result
- Auto-increment request IDs
- Handle connection cleanup
- Timeout handling: if no response within 30 seconds, throw
- The client should be initialized once per cron run, reused for all calls, then closed

**Key implementation detail:** Cloudflare Workers can consume SSE streams using the Fetch API with `response.body` as a ReadableStream. The client needs to:
1. Start the SSE connection (keep it open for the duration of the run)
2. Parse SSE events from the stream in the background
3. Route responses to pending requests by matching `id` fields
4. Use a Map<number, Promise resolver> pattern for request/response matching

**Interface:**
```typescript
export class McpClient {
  private endpoint: string | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private reader: ReadableStreamDefaultReader | null = null;

  async connect(): Promise<void>;           // SSE connect + initialize handshake
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  async close(): Promise<void>;             // Cleanup
}
```

**SSE parsing:** Events arrive as `data: {json}\n\n`. Each line starting with `data: ` contains a JSON-RPC response. Match `id` to pending requests.

**Error handling:** If the SSE connection drops mid-run, throw an error. The orchestrator will catch it and skip the remaining work (next hourly run retries).

---

#### Agent C: Decision Logic (Evaluator + Parser)
**Model:** sonnet
**Files to create:** `src/evaluator.ts`, `src/parser.ts`

**src/evaluator.ts** - Pure logic, zero I/O:

```typescript
import type { StepAnalytics, Step, Decision, SafetyResult, KillAction } from './types';

// Evaluate a single variant
export function evaluateVariant(sent: number, opportunities: number, threshold: number): Decision

// Safety check before killing - can we kill this variant?
export function safetyCheck(step: Step, killTargetIndex: number): SafetyResult

// Process all analytics for a campaign step, return kill actions
// Handles multiple kill candidates in one step correctly
export function evaluateStep(
  analytics: StepAnalytics[],     // analytics for this step only
  step: Step,                      // campaign detail step (for v_disabled check)
  stepIndex: number,
  threshold: number
): { kills: number[]; notification: NotificationType }
```

**evaluateVariant logic:**
1. If `sent < threshold` -> SKIP ("Below minimum sends gate")
2. If `opportunities === 0` -> KILL_CANDIDATE ("N sent, 0 opportunities")
3. If `sent / opportunities > threshold` -> KILL_CANDIDATE ("Ratio X:1 exceeds threshold")
4. Else -> KEEP ("Ratio X:1 within threshold")

**safetyCheck logic:**
1. Count active variants in step (where `v_disabled` is not `true`) excluding the kill target
2. If 0 remaining -> `{ canKill: false, notify: 'LAST_VARIANT' }`
3. If 1 remaining -> `{ canKill: true, notify: 'DOWN_TO_ONE' }`
4. If 2+ remaining -> `{ canKill: true, notify: null }`

**evaluateStep logic (handles multiple kills per step):**
1. Filter analytics to only variants where `v_disabled` is NOT true on the step
2. Evaluate each active variant
3. Collect all KILL_CANDIDATE indices
4. Sort by worst performance (highest ratio first, 0 opps = infinity)
5. Iteratively apply safety check: for each candidate, check if killing it (plus all previously confirmed kills) would leave >= 1 active variant
6. Stop when safety check says canKill: false
7. Return the list of confirmed kill indices and the worst notification type encountered

**src/parser.ts** - CM name extraction:

```typescript
import { CM_CHANNEL_MAP } from './config';

// Extract CM name from campaign title, return Slack channel ID
export function parseCmChannel(campaignName: string, fallbackChannel: string): string

// Extract CM name (for logging)
export function parseCmName(campaignName: string): string | null
```

**Parser logic:**
1. Find all parenthesized values: match all `\(([^)]+)\)` in the campaign name
2. Filter out `(copy)` tokens (case-insensitive)
3. Take the LAST remaining parenthesized value -> this is the CM name
4. If no parenthesized value found, try fallback: match last `- (\w+)` token (for Lautaro-style names like `ON - HOTELS - LAUTARO`)
5. Normalize to uppercase
6. Look up in `CM_CHANNEL_MAP`
7. If found -> return channel ID
8. If not found -> return `fallbackChannel`

**Test cases the parser must handle:**
- `ON - PAIR 11 - Property Management (ANDRES)` -> ANDRES
- `ON - RG1780 RG1781 - Angels Funding - From Ben 3 (LEO)` -> LEO
- `(CARLOS) (copy)` -> CARLOS
- `(CARLOS) (copy) (copy)` -> CARLOS
- `ON - HOTELS - LAUTARO` -> LAUTARO (fallback pattern)
- `ON - CLEANING Pair 3 (ANDRES) X` -> ANDRES (ignore suffix after parens)
- `OFF - RG990+RG991 - Credora - CONSULTING GMAPS - (EYVER) RB` -> EYVER
- `TEST` -> fallback channel
- `ERC 1` -> fallback channel

Wait - the suffix after parens issue: `(ANDRES) X`. The regex `\(([^)]+)\)` captures content INSIDE parens only, so `X` is not captured. This naturally works. But `(EYVER) RB` - same thing, `RB` is outside parens. The parser grabs the last parenthesized value which is `EYVER`. Correct.

---

#### Agent D: Slack Notifier
**Model:** sonnet
**Files to create:** `src/slack.ts`

```typescript
import type { KillAction, Env } from './types';

// Send a notification to the appropriate CM channel
export async function sendKillNotification(action: KillAction, channelId: string, env: Env): Promise<void>

// Send a "can't kill - last variant" notification
export async function sendLastVariantNotification(action: KillAction, channelId: string, env: Env): Promise<void>

// Format the kill notification message (exported for testing)
export function formatKillMessage(action: KillAction): string

// Format the last-variant-block message (exported for testing)
export function formatLastVariantMessage(action: KillAction): string
```

**Slack API call:**
```typescript
async function postSlackMessage(channel: string, text: string, token: string): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text }),
  });
  if (!res.ok) {
    console.error(`Slack API error: ${res.status} ${await res.text()}`);
  }
}
```

**Message format - Type 1: Killed variant (DOWN_TO_ONE or normal kill):**
```
:rotating_light: Auto Turn-Off: Variant disabled

Workspace: {workspaceName}
Campaign: {campaignName}
Step {stepIndex+1}, Variant {VARIANT_LABELS[variantIndex]} -> DISABLED

Emails sent: {sent}
Opportunities: {opportunities}
{ratio line: "Ratio: {sent}:{opportunities} = X:1 (threshold: 4,000:1)" OR "0 opportunities past 4,000 sends"}

{if DOWN_TO_ONE:}
:warning: Step {stepIndex+1} now has only {survivingVariantCount} active variant.
Add new variants to restore diversity and reduce deliverability risk.
```

**Message format - Type 2: Last variant block (LAST_VARIANT):**
```
:warning: Auto Turn-Off: Cannot disable variant

Workspace: {workspaceName}
Campaign: {campaignName}
Step {stepIndex+1}, Variant {VARIANT_LABELS[variantIndex]}

This variant exceeded the kill threshold:
Emails sent: {sent}
Opportunities: {opportunities}
{ratio line}

But it's the LAST active variant in Step {stepIndex+1}. The system did NOT disable it.

Action needed: Add 1+ new variants to this step, then manually turn off Variant {label}.
```

**In dry-run mode:** Do NOT call Slack API. Just `console.log` the formatted message.

---

### Phase 2: Sequential (1 agent, after ALL Phase 1 agents complete)

#### Agent E: Instantly Layer + Orchestrator + Integration
**Model:** sonnet (or opus for the orchestrator complexity)
**Files to create:** `src/instantly.ts`, `src/index.ts`
**Required:** Must READ all Phase 1 files first (`types.ts`, `config.ts`, `mcp-client.ts`, `evaluator.ts`, `parser.ts`, `slack.ts`) to understand interfaces.

**src/instantly.ts** - Instantly-specific API functions:

```typescript
import { McpClient } from './mcp-client';
import type { Workspace, Campaign, StepAnalytics, CampaignDetail } from './types';

export class InstantlyApi {
  constructor(private mcp: McpClient) {}

  async listWorkspaces(): Promise<Workspace[]>
  async getCampaigns(workspaceId: string): Promise<Campaign[]>
  async getStepAnalytics(workspaceId: string, campaignId: string): Promise<StepAnalytics[]>
  async getCampaignDetails(workspaceId: string, campaignId: string): Promise<CampaignDetail>
  async disableVariant(workspaceId: string, campaign: CampaignDetail, stepIndex: number, variantIndex: number): Promise<boolean>
}
```

**listWorkspaces:** Call `list_workspaces`, parse response, return array.

**getCampaigns:** Call `get_campaigns` with `status: "active"`, `limit: 100`. Parse response.

**getStepAnalytics:** Call `get_step_analytics` with `campaign_id` and `include_opportunities: true`. Parse response. The response is an array of StepAnalytics objects.

**getCampaignDetails:** Call `get_campaign_details`. Parse response. The response includes the full `sequences` array with steps and variants.

**disableVariant:** This is the critical function.
1. The `campaign` parameter is the ALREADY-FETCHED campaign detail (don't fetch again)
2. Deep-clone the sequences array
3. Set `sequences[0].steps[stepIndex].variants[variantIndex].v_disabled = true`
4. Call `update_campaign` with `updates: { sequences: clonedSequences }`
5. Fetch campaign details again to verify
6. Return true if verification shows `v_disabled: true` on the target variant
7. Return false if verification fails (log warning)

**MCP response parsing:** MCP tool responses come as:
```json
{
  "result": {
    "content": [{ "type": "text", "text": "{\"actual\": \"json data here\"}" }]
  }
}
```
The actual data is JSON-stringified inside `content[0].text`. Parse it: `JSON.parse(result.content[0].text)`.

**src/index.ts** - The orchestrator:

```typescript
import { McpClient } from './mcp-client';
import { InstantlyApi } from './instantly';
import { evaluateVariant, safetyCheck } from './evaluator';
import { parseCmChannel, parseCmName } from './parser';
import { sendKillNotification, sendLastVariantNotification } from './slack';
import { FUNDING_WORKSPACE_NAMES } from './config';
import type { Env, KillAction, StepAnalytics } from './types';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Main cron handler
  }
};
```

**Orchestrator flow:**

```
1. ACQUIRE LOCK
   - Check KV key "auto-turnoff-lock"
   - If exists and < 30 min old -> log "skipping, previous run active" -> return
   - Set lock with current timestamp

2. CONNECT MCP
   - Create McpClient, call connect()
   - Create InstantlyApi with the client

3. GET FUNDING WORKSPACES
   - Call listWorkspaces()
   - Filter to FUNDING_WORKSPACE_NAMES
   - Log: "Processing N funding workspaces"

4. FOR EACH WORKSPACE (sequential):
   a. Log: "Processing workspace: {name}"
   b. GET active campaigns (getCampaigns)
   c. Log: "{N} active campaigns"

   d. FOR EACH CAMPAIGN (parallel with concurrency cap from env.CONCURRENCY_CAP):
      i.   GET step analytics (getStepAnalytics)
      ii.  Parse threshold from env.THRESHOLD

      iii. QUICK GATE: Check if ANY variant has sent >= threshold
           - If no -> skip campaign (log at debug level)
           - If yes -> continue

      iv.  GET campaign details (getCampaignDetails)
      v.   Determine primary step count: campaign.sequences[0].steps.length
      vi.  Filter analytics to primary steps only (step index < primaryStepCount)

      vii. FOR EACH STEP in primary sequence:
           - Get analytics for this step
           - Get step detail from campaign.sequences[0].steps[stepIndex]
           - Filter out analytics for already-disabled variants (check v_disabled)
           - Evaluate each active variant
           - Collect kill candidates
           - Apply safety checks iteratively

           FOR EACH CONFIRMED KILL:
             - Build KillAction object
             - Parse CM channel from campaign name

             IF DRY_RUN == "true":
               - Log: "[DRY RUN] Would kill: {workspace} / {campaign} / Step {N} Variant {X}"
               - Log the full decision details
             ELSE:
               - Call disableVariant()
               - If success: send Slack notification (kill or last-variant)
               - If fail: log error, continue

   e. Log workspace summary: "{N} campaigns evaluated, {M} variants killed, {K} notifications sent"

5. LOG RUN SUMMARY
   - Total workspaces, campaigns, variants killed, notifications, errors, duration

6. RELEASE LOCK
   - Delete KV key "auto-turnoff-lock"

7. CLOSE MCP
   - Call mcp.close()
```

**Concurrency control for campaigns within a workspace:**
```typescript
async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await fn(item);
    }
  });
  await Promise.all(workers);
}
```

**KV Lock implementation:**
```typescript
async function acquireLock(kv: KVNamespace): Promise<boolean> {
  const existing = await kv.get('auto-turnoff-lock');
  if (existing) {
    const lockTime = parseInt(existing);
    if (Date.now() - lockTime < 30 * 60 * 1000) {
      return false;
    }
  }
  await kv.put('auto-turnoff-lock', Date.now().toString());
  return true;
}

async function releaseLock(kv: KVNamespace): Promise<void> {
  await kv.delete('auto-turnoff-lock');
}
```

**Error isolation:**
- Wrap each workspace in try/catch. If one fails, log and continue to next.
- Wrap each campaign in try/catch. If one fails, log and continue to next.
- Wrap each PATCH in try/catch. If one fails, log and continue.
- Wrap each Slack call in try/catch. If one fails, log and continue.
- Never let a single failure stop the entire run.

---

## Deployment Steps (After Build)

1. `cd builds/auto-turn-off && npm install`
2. `wrangler login` (if not already logged in)
3. `wrangler kv namespace create KV` -> copy the ID into `wrangler.toml`
4. Set secrets:
   ```
   wrangler secret put SLACK_BOT_TOKEN  # (empty string for now - dry run doesn't need it)
   ```
5. Set env vars in `wrangler.toml`:
   ```toml
   [vars]
   DRY_RUN = "true"
   THRESHOLD = "4000"
   CONCURRENCY_CAP = "5"
   SLACK_FALLBACK_CHANNEL = ""  # MUST set a real channel ID before going live (see below)
   SLACK_BOT_TOKEN = ""
   ```
6. `wrangler deploy`
7. Test with `wrangler dev` (local) or trigger cron manually: `curl "https://auto-turnoff.{account}.workers.dev/__scheduled"`

### Fallback Channel (Required Before Live Mode)

Many campaigns have no CM name in their title (ERC campaigns, Outlook 1 generics, Automated applications). When the parser can't extract a CM, notifications route to `SLACK_FALLBACK_CHANNEL`. If this is empty, those notifications are lost (kills still execute, but silently).

**Before setting `DRY_RUN=false`:**
1. Create a `#notifications-unassigned` channel in Slack (or pick an existing ops channel)
2. Add the Slack bot to that channel
3. Set `SLACK_FALLBACK_CHANNEL` to the channel ID in `wrangler.toml`

---

## What NOT to Build

- No database or persistent storage beyond KV lock
- No retry logic (hourly cron IS the retry)
- No warning zone or graduated thresholds (v2)
- No per-infrastructure thresholds (v2)
- No subsequence evaluation (v3)
- No logging to external systems (Workers logs are sufficient)
- No web UI or API endpoints (cron-only)
- No tests in v1 (the dry-run mode IS the test - run it and verify decisions manually)

---

## Verification Plan

After deploying in dry-run mode:

1. Trigger a manual run via `wrangler dev` or the scheduled endpoint
2. Check Workers logs for:
   - All 13 workspaces processed
   - Correct number of active campaigns per workspace
   - Gate correctly skipping low-volume variants
   - Kill decisions match manual spot-checks (pick 2-3 campaigns, verify in Instantly UI)
   - Disabled variants correctly filtered out
   - Subsequence steps correctly ignored
   - CM names correctly parsed
   - Notification messages correctly formatted
3. Compare dry-run kill list against what CMs are manually monitoring
4. Run for 24-48 hours in dry-run, checking logs each cycle
5. When confident: set `DRY_RUN=false`, add real `SLACK_BOT_TOKEN`

---

## Agent Dispatch Summary

| Agent | Phase | Model | Files | Dependencies |
|-------|-------|-------|-------|-------------|
| A: Scaffolding | 1 (parallel) | sonnet | package.json, tsconfig.json, wrangler.toml, types.ts, config.ts | None |
| B: MCP Client | 1 (parallel) | sonnet | mcp-client.ts | None |
| C: Decision Logic | 1 (parallel) | sonnet | evaluator.ts, parser.ts | None |
| D: Slack Notifier | 1 (parallel) | sonnet | slack.ts | None |
| E: Integration | 2 (sequential) | sonnet | instantly.ts, index.ts | Reads all Phase 1 outputs |
