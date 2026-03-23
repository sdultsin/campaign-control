# MCP Durable Object Integration

## What was built

Two new files — no existing files modified. Apply the changes below when ready to deploy.

---

## New files

- `src/mcp-durable-object.ts` — the Durable Object class
- `src/mcp-do-client.ts` — thin client the cron Worker uses instead of McpClient

---

## wrangler.toml changes

Add a Durable Object binding and migration block. Replace the current wrangler.toml with:

```toml
name = "auto-turnoff"
main = "src/index.ts"
compatibility_date = "2025-03-15"
account_id = "8eb4f67f852e00194242db7f998cb06b"

[triggers]
crons = ["0 10,12,16,22 * * *"]

[[kv_namespaces]]
binding = "KV"
id = "c054b62e43b54a22bcc1ffa24bb72272"

[vars]
DRY_RUN = "false"
THRESHOLD = "4000"
CONCURRENCY_CAP = "5"
SLACK_FALLBACK_CHANNEL = "C0AMRK8RC4R"
KILLS_ENABLED = "true"
INSTANTLY_MODE = "direct"

# --- NEW: Durable Object binding ---
[[durable_objects.bindings]]
name = "MCP_DO"
class_name = "McpDurableObject"

# Migration required on first deploy with a DO
[[migrations]]
tag = "v1"
new_classes = ["McpDurableObject"]
```

---

## types.ts change

Add `MCP_DO` to the `Env` interface in `src/types.ts`:

```typescript
export interface Env {
  KV: KVNamespace;
  MCP_DO: DurableObjectNamespace;   // <-- ADD THIS LINE
  DRY_RUN: string;
  CONCURRENCY_CAP: string;
  SLACK_BOT_TOKEN: string;
  SLACK_FALLBACK_CHANNEL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  KILLS_ENABLED: string;
  INSTANTLY_API_KEYS: string;
  INSTANTLY_MODE: string;
}
```

---

## index.ts changes

### 1. Add import (top of file, ~line 1-2)

```typescript
// ADD alongside existing McpClient import:
import { McpDoClient } from './mcp-do-client';
```

### 2. Export McpDurableObject (bottom of file or alongside the Worker export)

The DO class must be re-exported from the Worker's entry point so the runtime
can find it by class name.

```typescript
// At the bottom of index.ts, alongside `export default { fetch, scheduled }`:
export { McpDurableObject } from './mcp-durable-object';
```

### 3. Phase 3 connection block (~line 1504-1517)

Replace:
```typescript
let phase3Mcp: McpClient | null = null;
let phase3McpApi: InstantlyApi | null = null;
if (useDirectApi && leadsCheckCandidates.length > 0) {
  const p3mcp = new McpClient();
  try {
    await p3mcp.connect();
    phase3Mcp = p3mcp;
    phase3McpApi = new InstantlyApi(p3mcp);
    console.log('[auto-turnoff] Phase 3 MCP connected — will use count_leads for exact lead status (incl. skipped)');
  } catch (p3ConnErr) {
    console.warn(`[auto-turnoff] Phase 3 MCP connect failed, falling back to batch analytics: ${p3ConnErr}`);
    await p3mcp.close().catch(() => {});
  }
}
```

With:
```typescript
// McpClient | McpDoClient — both implement connect/callTool/close
let phase3Mcp: McpClient | McpDoClient | null = null;
let phase3McpApi: InstantlyApi | null = null;
if (useDirectApi && leadsCheckCandidates.length > 0) {
  // Use the Durable Object client if the binding is present; fall back to
  // direct McpClient if MCP_DO is not yet deployed (e.g. in a staging env).
  const p3mcp = env.MCP_DO
    ? new McpDoClient(env.MCP_DO)
    : new McpClient();
  try {
    await p3mcp.connect();
    phase3Mcp = p3mcp;
    phase3McpApi = new InstantlyApi(p3mcp);
    const clientType = env.MCP_DO ? 'McpDoClient (Durable Object)' : 'McpClient (direct SSE)';
    console.log(`[auto-turnoff] Phase 3 MCP connected via ${clientType} — will use count_leads for exact lead status (incl. skipped)`);
  } catch (p3ConnErr) {
    console.warn(`[auto-turnoff] Phase 3 MCP connect failed, falling back to batch analytics: ${p3ConnErr}`);
    await p3mcp.close().catch(() => {});
  }
}
```

The `phase3Mcp.close()` call in the finally block (~line 1910) and all other
usage of `phase3Mcp` / `phase3McpApi` requires no changes — McpDoClient
implements the same interface as McpClient.

---

## How it works end-to-end

```
Cron Worker (index.ts)
  └─ McpDoClient.connect()
       └─ POST http://do/connect  →  McpDurableObject.fetch()
            └─ openConnection()
                 ├─ GET /sse  →  Railway MCP server
                 ├─ pump() background loop (reads SSE stream forever)
                 └─ MCP initialize handshake

  └─ McpDoClient.callTool("count_leads", {...})
       └─ POST http://do/call  →  McpDurableObject.fetch()
            ├─ registers pending[id]
            ├─ POST to MCP endpoint URL (from endpoint SSE event)
            ├─ pump() receives response over SSE stream
            └─ resolves pending[id] → returns JSON to Worker

  └─ McpDoClient.close()
       └─ POST http://do/close  →  tears down SSE, cancels idle alarm
```

## Key properties

- **One SSE connection per run**: the DO is keyed by `"mcp-singleton"` — all cron
  invocations share the same live instance and connection.
- **Auto-reconnect**: if the connection dropped between the connect() call and a
  callTool() call (Railway idle timeout), the DO reconnects transparently.
- **Idle timeout**: 5 minutes after the last call, the DO's alarm fires and
  releases the upstream Railway connection. The DO instance stays alive.
- **Fallback safety**: if `env.MCP_DO` is absent (not yet deployed), the code
  falls back to `new McpClient()` — no run failure.
- **Drop-in interface**: McpDoClient exposes exactly `connect()`, `callTool<T>()`,
  and `close()` — no changes required to `InstantlyApi` or any call site.
