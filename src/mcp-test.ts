/**
 * MCP SSE Connectivity Test Worker
 *
 * Purpose: Verify that a Cloudflare Worker can successfully open an SSE connection to the
 * Railway-hosted MCP server, run the handshake, and call count_leads for a real campaign.
 *
 * Deploy as a *separate* Worker (not as the main auto-turnoff Worker) to isolate the test
 * from any production side effects. It has no scheduled trigger and no KV bindings; it only
 * needs the same INSTANTLY_API_KEYS secret (to supply a real workspace ID) or a hard-coded
 * campaign ID below.
 *
 * Deployment (one-shot, manual):
 *   cd builds/auto-turn-off
 *   npx wrangler deploy src/mcp-test.ts --name mcp-sse-test --compatibility-date 2025-03-15
 *
 * Then hit:  https://mcp-sse-test.<your-subdomain>.workers.dev/__mcp-test
 *
 * Read the JSON response body for timing + result details.
 *
 * IMPORTANT: Delete the Worker after testing — it has no auth and no rate-limit.
 *   npx wrangler delete --name mcp-sse-test
 *
 * ---------------------------------------------------------------------------
 * What this tests
 * ---------------------------------------------------------------------------
 * 1. fetch() with Accept: text/event-stream to Railway SSE endpoint
 * 2. response.body.getReader() — CF Workers ReadableStream support for SSE
 * 3. Receiving the "endpoint" SSE event within 10 seconds (default timeout in McpClient)
 * 4. POST initialize to the returned endpoint URL
 * 5. Receiving the initialize response over the SSE stream (within 30 seconds)
 * 6. POST notifications/initialized (fire-and-forget)
 * 7. POST tools/call for count_leads with a known campaign ID
 * 8. Receiving the count_leads response over the SSE stream
 * 9. Graceful close (reader.cancel() + AbortController.abort())
 *
 * Each step is timed individually. If any step fails, the response body contains which step
 * failed, how long it took, and the raw error message.
 */

import { MCP_SSE_URL } from './config';

// ---------------------------------------------------------------------------
// Test configuration — update CAMPAIGN_ID to a real campaign that has leads
// ---------------------------------------------------------------------------

// A known active campaign from Renaissance 1 workspace. Replace with any real campaign ID
// that has leads. This is only used for count_leads; the test will not modify anything.
const TEST_WORKSPACE_ID = 'renaissance-1';

// Fill in a real campaign ID here (e.g. from Instantly UI -> campaign URL).
// If left blank the test will still exercise steps 1-6 (connect + initialize) and skip
// the count_leads call, which is safe for a connectivity-only check.
const TEST_CAMPAIGN_ID = 'd0249876-d43c-480e-bc74-61b43ee3cb9e'; // Home Services Pair 21 (ANDRES)

// ---------------------------------------------------------------------------
// Inline MCP implementation mirrored from mcp-client.ts but with per-step timing
// ---------------------------------------------------------------------------

interface StepResult {
  step: string;
  ok: boolean;
  durationMs: number;
  detail?: unknown;
}

interface TestResult {
  success: boolean;
  totalMs: number;
  mcpSseUrl: string;
  steps: StepResult[];
  countLeadsResult?: unknown;
  failedAt?: string;
  error?: string;
}

async function runMcpTest(): Promise<TestResult> {
  const steps: StepResult[] = [];
  const testStart = Date.now();

  let endpointUrl: string | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let abortController: AbortController | null = null;

  // pending map: request id -> { resolve, reject, timer }
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let nextId = 1;

  // SSE parse state
  const decoder = new TextDecoder();
  let buffer = '';

  // Resolve endpoint event
  let endpointResolve: ((url: string) => void) | null = null;
  let endpointReject: ((e: unknown) => void) | null = null;
  const endpointPromise = new Promise<string>((res, rej) => {
    endpointResolve = res;
    endpointReject = rej;
  });

  // ---------------------------------------------------------------------------
  // pump() — reads SSE stream in a loop; resolves endpoint promise and pending
  // tool call promises as events arrive
  // ---------------------------------------------------------------------------
  async function pump(): Promise<void> {
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchBlock(block);
      }
    }
    // Stream closed: reject any pending requests
    const streamErr = new Error('SSE stream closed unexpectedly');
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(streamErr);
    }
    pending.clear();
    endpointReject?.(streamErr);
  }

  function dispatchBlock(block: string): void {
    let eventType = 'message';
    let data = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice('event: '.length).trim();
      else if (line.startsWith('data: ')) data = line.slice('data: '.length).trim();
    }

    if (eventType === 'endpoint') {
      endpointResolve?.(data);
      endpointResolve = null;
      endpointReject = null;
      return;
    }

    if (!data) return;
    let msg: { id?: number; result?: unknown; error?: unknown };
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id)!;
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
  }

  async function post(endpoint: string, body: unknown): Promise<void> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${endpoint} failed: ${res.status} ${res.statusText} — ${text}`);
    }
  }

  async function request(endpoint: string, method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = nextId++;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for response to ${method} (id=${id})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    await post(endpoint, { jsonrpc: '2.0', id, method, params });
    return responsePromise;
  }

  // ---------------------------------------------------------------------------
  // STEP 1: Open SSE GET connection
  // ---------------------------------------------------------------------------
  {
    const t = Date.now();
    try {
      abortController = new AbortController();
      const response = await fetch(MCP_SSE_URL, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText} — no body`);
      }

      reader = response.body.getReader();

      // Start pump (non-awaited — runs concurrently while we await events)
      pump().catch((pumpErr) => {
        const e = pumpErr instanceof Error ? pumpErr : new Error(String(pumpErr));
        endpointReject?.(e);
        for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(e); }
        pending.clear();
      });

      steps.push({ step: 'sse_connect', ok: true, durationMs: Date.now() - t, detail: { status: response.status } });
    } catch (err) {
      steps.push({ step: 'sse_connect', ok: false, durationMs: Date.now() - t, detail: String(err) });
      return { success: false, totalMs: Date.now() - testStart, mcpSseUrl: MCP_SSE_URL, steps, failedAt: 'sse_connect', error: String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Wait for endpoint event (10-second timeout)
  // ---------------------------------------------------------------------------
  {
    const t = Date.now();
    try {
      const timeoutHandle = setTimeout(() => endpointReject?.(new Error('Timeout waiting for endpoint event (10s)')), 10_000);
      endpointUrl = await endpointPromise;
      clearTimeout(timeoutHandle);
      steps.push({ step: 'endpoint_event', ok: true, durationMs: Date.now() - t, detail: { endpointUrl } });
    } catch (err) {
      steps.push({ step: 'endpoint_event', ok: false, durationMs: Date.now() - t, detail: String(err) });
      abortController?.abort();
      return { success: false, totalMs: Date.now() - testStart, mcpSseUrl: MCP_SSE_URL, steps, failedAt: 'endpoint_event', error: String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 3: Send initialize and wait for response (30-second timeout)
  // ---------------------------------------------------------------------------
  {
    const t = Date.now();
    try {
      const initResponse = await request(endpointUrl, 'initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'mcp-sse-test', version: '1.0.0' },
        capabilities: {},
      }, 30_000);
      steps.push({ step: 'initialize', ok: true, durationMs: Date.now() - t, detail: initResponse });
    } catch (err) {
      steps.push({ step: 'initialize', ok: false, durationMs: Date.now() - t, detail: String(err) });
      abortController?.abort();
      return { success: false, totalMs: Date.now() - testStart, mcpSseUrl: MCP_SSE_URL, steps, failedAt: 'initialize', error: String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 4: Send notifications/initialized (fire-and-forget, no response expected)
  // ---------------------------------------------------------------------------
  {
    const t = Date.now();
    try {
      await post(endpointUrl, { jsonrpc: '2.0', method: 'notifications/initialized' });
      steps.push({ step: 'notifications_initialized', ok: true, durationMs: Date.now() - t });
    } catch (err) {
      // Non-fatal: server may not need this
      steps.push({ step: 'notifications_initialized', ok: false, durationMs: Date.now() - t, detail: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 5a: Call list_workspaces (fast, simple — tests whether ANY tool call works)
  // ---------------------------------------------------------------------------
  {
    const t = Date.now();
    try {
      const raw = await request(endpointUrl, 'tools/call', {
        name: 'list_workspaces',
        arguments: {},
      }, 30_000);
      const resp = raw as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
      if (resp.error) throw new Error(`MCP tool error: ${resp.error.message ?? JSON.stringify(resp.error)}`);
      const text = resp.result?.content?.[0]?.text;
      steps.push({ step: 'list_workspaces', ok: true, durationMs: Date.now() - t, detail: text ? JSON.parse(text) : raw });
    } catch (err) {
      steps.push({ step: 'list_workspaces', ok: false, durationMs: Date.now() - t, detail: String(err) });
      // Non-fatal: continue to count_leads test
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 5b: Call count_leads (only if TEST_CAMPAIGN_ID is set)
  // ---------------------------------------------------------------------------
  let countLeadsResult: unknown = null;
  if (TEST_CAMPAIGN_ID) {
    const t = Date.now();
    try {
      const raw = await request(endpointUrl, 'tools/call', {
        name: 'count_leads',
        arguments: { workspace_id: TEST_WORKSPACE_ID, campaign_id: TEST_CAMPAIGN_ID },
      }, 30_000);

      // Extract text content from MCP response envelope
      const resp = raw as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
      if (resp.error) throw new Error(`MCP tool error: ${resp.error.message ?? JSON.stringify(resp.error)}`);
      const text = resp.result?.content?.[0]?.text;
      if (!text) throw new Error(`Unexpected response shape: ${JSON.stringify(raw).slice(0, 300)}`);
      countLeadsResult = JSON.parse(text);
      steps.push({ step: 'count_leads', ok: true, durationMs: Date.now() - t, detail: countLeadsResult });
    } catch (err) {
      steps.push({ step: 'count_leads', ok: false, durationMs: Date.now() - t, detail: String(err) });
      abortController?.abort();
      return {
        success: false,
        totalMs: Date.now() - testStart,
        mcpSseUrl: MCP_SSE_URL,
        steps,
        failedAt: 'count_leads',
        error: String(err),
      };
    }
  } else {
    steps.push({ step: 'count_leads', ok: true, durationMs: 0, detail: 'SKIPPED — TEST_CAMPAIGN_ID not set' });
  }

  // ---------------------------------------------------------------------------
  // STEP 6: Graceful close
  // ---------------------------------------------------------------------------
  {
    const t = Date.now();
    try {
      await reader?.cancel();
    } catch { /* ignore */ }
    abortController?.abort();
    steps.push({ step: 'close', ok: true, durationMs: Date.now() - t });
  }

  return {
    success: true,
    totalMs: Date.now() - testStart,
    mcpSseUrl: MCP_SSE_URL,
    steps,
    ...(countLeadsResult ? { countLeadsResult } : {}),
  };
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/__mcp-test') {
      return new Response(
        JSON.stringify({
          usage: 'GET /__mcp-test',
          description: 'Runs a full MCP SSE connectivity test against the Railway MCP server.',
          mcpSseUrl: MCP_SSE_URL,
          note: TEST_CAMPAIGN_ID
            ? `Will call count_leads for campaign ${TEST_CAMPAIGN_ID} in workspace ${TEST_WORKSPACE_ID}`
            : 'TEST_CAMPAIGN_ID is empty — will test connect+initialize only (no count_leads call). Set it in mcp-test.ts to test the full round trip.',
        }, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const result = await runMcpTest();
    return new Response(JSON.stringify(result, null, 2), {
      status: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
