/**
 * McpDurableObject — Durable Object that maintains a persistent SSE connection
 * to the King Instantly MCP server and proxies JSON-RPC tool calls from the
 * cron Worker.
 *
 * Why a Durable Object?
 *  - DOs have unlimited wall-clock time; a cron Worker's CPU budget is shared
 *    across all concurrent fetch() calls, making long-lived SSE streams fragile.
 *  - The DO stays alive between calls; the SSE connection is established once
 *    and reused across many callTool() invocations in the same run.
 *  - An alarm-based idle timeout releases the upstream connection after 5 min
 *    of inactivity without evicting the DO itself.
 *
 * Endpoints exposed via fetch():
 *   POST /connect  — open SSE connection + MCP initialize handshake
 *   POST /call     — { tool: string, args: Record<string, unknown> } → tool result
 *   POST /close    — tear down SSE connection immediately
 *
 * The DO is keyed by a fixed stub ID ("mcp-singleton") so all cron runs share
 * the same instance and the same connection.
 */

import { MCP_SSE_URL } from './config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CallRequestBody {
  tool: string;
  args: Record<string, unknown>;
}

// Minimal Durable Object state shape (avoids needing @cloudflare/workers-types)
interface DOState {
  storage: {
    setAlarm(time: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds of inactivity before the SSE connection is released. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** How long to wait for the SSE endpoint event after opening the stream. */
const ENDPOINT_TIMEOUT_MS = 15_000;

/** Per-call response timeout. */
const CALL_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// McpDurableObject
// ---------------------------------------------------------------------------

export class McpDurableObject {
  private state: DOState;

  // SSE connection state
  private endpoint: string | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  // Temporary resolver injected during connect() so pump() can hand off
  // the endpoint URL before proceeding.
  private _endpointResolver: ((url: string) => void) | null = null;
  private _endpointRejector: ((err: unknown) => void) | null = null;

  constructor(state: DOState, _env: unknown) {
    this.state = state;
  }

  // ---------------------------------------------------------------------------
  // Public: fetch() router
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    switch (url.pathname) {
      case '/connect':
        return this.handleConnect();
      case '/call': {
        const body = await request.json<CallRequestBody>();
        return this.handleCall(body);
      }
      case '/close':
        return this.handleClose();
      default:
        return new Response('Not Found', { status: 404 });
    }
  }

  // ---------------------------------------------------------------------------
  // Public: alarm() — idle timeout handler
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    console.log('[McpDO] Idle timeout — releasing SSE connection');
    await this.teardown('idle timeout');
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async handleConnect(): Promise<Response> {
    if (this.endpoint) {
      // Already connected — reset the idle timer and return immediately.
      await this.resetIdleTimer();
      return Response.json({ ok: true, alreadyConnected: true });
    }

    try {
      await this.openConnection();
      await this.resetIdleTimer();
      return Response.json({ ok: true });
    } catch (err) {
      await this.teardown('connect error');
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  }

  private async handleCall(body: CallRequestBody): Promise<Response> {
    const { tool, args } = body;

    // Auto-reconnect if the connection was dropped between calls.
    if (!this.endpoint) {
      try {
        console.log('[McpDO] Not connected — auto-reconnecting before call');
        await this.openConnection();
      } catch (reconnErr) {
        await this.teardown('reconnect error');
        const msg = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
        return Response.json({ ok: false, error: `Reconnect failed: ${msg}` }, { status: 503 });
      }
    }

    await this.resetIdleTimer();

    const id = this.nextId++;

    try {
      // Register the pending handler BEFORE firing the POST so we can never
      // miss a lightning-fast response (executor runs synchronously).
      const resultPromise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for tool response: ${tool} (id=${id})`));
        }, CALL_TIMEOUT_MS);

        this.pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (reason) => {
            clearTimeout(timer);
            reject(reason);
          },
        });
      });

      // Fire the POST now that the pending slot is registered.
      await this.post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      });

      // Wait for the SSE response to arrive via pump() → dispatchSseBlock().
      const result = await resultPromise;

      const response = result as {
        result?: { content?: Array<{ text?: string }> };
        error?: { message?: string; code?: number };
      };

      if (response.error) {
        return Response.json(
          { ok: false, error: `MCP tool error [${tool}]: ${response.error.message ?? JSON.stringify(response.error)}` },
          { status: 400 },
        );
      }

      const text = response.result?.content?.[0]?.text;
      if (text === undefined) {
        return Response.json(
          { ok: false, error: `Unexpected MCP response shape for tool ${tool}: ${JSON.stringify(response)}` },
          { status: 500 },
        );
      }

      return Response.json({ ok: true, data: JSON.parse(text) });
    } catch (err) {
      // Remove the stale pending entry if it survived (e.g. timeout).
      this.pending.delete(id);
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  }

  private async handleClose(): Promise<Response> {
    await this.teardown('explicit close');
    await this.state.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // SSE connection management
  // ---------------------------------------------------------------------------

  private async openConnection(): Promise<void> {
    this.abortController = new AbortController();

    const response = await fetch(MCP_SSE_URL, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    this.reader = response.body.getReader();

    // Race: wait for the endpoint event (server sends it immediately on connect).
    const endpointPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timeout waiting for SSE endpoint event')),
        ENDPOINT_TIMEOUT_MS,
      );
      this._endpointResolver = (url: string) => {
        clearTimeout(timeout);
        resolve(url);
      };
      this._endpointRejector = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });

    // Start the background pump. When it exits (stream closed or error), reject
    // all pending calls so the cron Worker gets immediate feedback rather than
    // waiting for per-call timeouts.
    this.pump()
      .then(() => {
        const dropErr = new Error('SSE stream closed (server idle timeout or DO eviction)');
        this.drainPending(dropErr);
        this.endpoint = null;
      })
      .catch((err) => {
        const dropErr = err instanceof Error ? err : new Error(String(err));
        this.drainPending(dropErr);
        this.endpoint = null;
      });

    this.endpoint = await endpointPromise;

    // MCP initialize handshake
    const initId = this.nextId++;
    const initPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(initId, { resolve, reject });
    });

    await this.post({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'auto-turnoff-do', version: '1.0.0' },
        capabilities: {},
      },
    });

    await initPromise;

    // Notify the server that initialization is complete (no response expected).
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private async teardown(reason: string): Promise<void> {
    console.log(`[McpDO] Teardown: ${reason}`);

    this.drainPending(new Error(`McpDurableObject teardown: ${reason}`));

    try {
      await this.reader?.cancel();
    } catch {
      // ignore
    }

    this.abortController?.abort();
    this.reader = null;
    this.abortController = null;
    this.endpoint = null;
    this._endpointResolver = null;
    this._endpointRejector = null;
  }

  private drainPending(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Idle timer
  // ---------------------------------------------------------------------------

  private async resetIdleTimer(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------------
  // SSE pump (background loop)
  // ---------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (!this.reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await this.reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.dispatchSseBlock(block);
      }
    }
  }

  private dispatchSseBlock(block: string): void {
    let eventType = 'message';
    let data = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice('event: '.length).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice('data: '.length).trim();
      }
    }

    if (eventType === 'endpoint') {
      if (this._endpointResolver) {
        this._endpointResolver(data);
        this._endpointResolver = null;
        this._endpointRejector = null;
      }
      return;
    }

    if (!data) return;

    let msg: { id?: number; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      // Not a JSON-RPC message — ignore (keep-alive ping, etc.)
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP POST to MCP endpoint
  // ---------------------------------------------------------------------------

  private async post(body: unknown): Promise<void> {
    if (!this.endpoint) {
      throw new Error('No MCP endpoint URL — SSE endpoint event not yet received.');
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP POST failed: ${res.status} ${res.statusText} — ${text}`);
    }
  }
}
