/**
 * McpDoClient — thin wrapper that routes MCP tool calls through the
 * McpDurableObject instead of opening a direct SSE connection from the
 * cron Worker.
 *
 * Implements the same connect() / callTool<T>() / close() interface as
 * McpClient so it's a drop-in replacement at the call site.
 *
 * The DO stub is addressed by a fixed name ("mcp-singleton") so all cron
 * runs share one live instance. The DO itself manages reconnection and the
 * idle-timeout alarm.
 *
 * Usage in index.ts (Phase 3):
 *
 *   import { McpDoClient } from './mcp-do-client';
 *
 *   const p3mcp = new McpDoClient(env.MCP_DO);   // MCP_DO is DurableObjectNamespace
 *   await p3mcp.connect();
 *   const api = new InstantlyApi(p3mcp);
 *   ...
 *   await p3mcp.close();
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal subset of DurableObjectNamespace needed here. */
interface DONamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): DOStub;
}

interface DOStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

// Response shapes from McpDurableObject
interface DoConnectResponse {
  ok: boolean;
  alreadyConnected?: boolean;
  error?: string;
}

interface DoCallResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface DoCloseResponse {
  ok: boolean;
}

// ---------------------------------------------------------------------------
// McpDoClient
// ---------------------------------------------------------------------------

/** Fixed Durable Object instance name — all Workers share one SSE connection. */
const DO_NAME = 'mcp-singleton';

export class McpDoClient {
  private stub: DOStub;

  constructor(doNamespace: DONamespace) {
    const id = doNamespace.idFromName(DO_NAME);
    this.stub = doNamespace.get(id);
  }

  // ---------------------------------------------------------------------------
  // Public API — mirrors McpClient
  // ---------------------------------------------------------------------------

  /**
   * Establish the SSE connection and run the MCP initialize handshake.
   * Safe to call when already connected (the DO returns {alreadyConnected: true}).
   */
  async connect(): Promise<void> {
    const res = await this.stub.fetch('http://do/connect', { method: 'POST' });
    const body = await res.json<DoConnectResponse>();

    if (!body.ok) {
      throw new Error(`McpDoClient connect failed: ${body.error ?? 'unknown error'}`);
    }
  }

  /**
   * Call an MCP tool and return the parsed JSON result.
   * Mirrors McpClient.callTool<T>().
   */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.stub.fetch('http://do/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, args }),
    });

    const body = await res.json<DoCallResponse<T>>();

    if (!body.ok || body.data === undefined) {
      throw new Error(`McpDoClient callTool failed [${name}]: ${body.error ?? 'no data returned'}`);
    }

    return body.data;
  }

  /**
   * Tear down the SSE connection in the DO.
   * The DO instance itself stays alive; only the upstream Railway connection
   * is closed. The idle-timeout alarm is also cancelled.
   */
  async close(): Promise<void> {
    try {
      const res = await this.stub.fetch('http://do/close', { method: 'POST' });
      const body = await res.json<DoCloseResponse>();
      if (!body.ok) {
        console.warn('[McpDoClient] close() returned not-ok (non-fatal)');
      }
    } catch (err) {
      // Close failures are non-fatal — the idle timeout will clean up.
      console.warn(`[McpDoClient] close() error (non-fatal): ${err}`);
    }
  }
}
