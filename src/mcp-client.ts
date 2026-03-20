import { MCP_SSE_URL } from './config';

export class McpClient {
  private endpoint: string | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;

  async connect(): Promise<void> {
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

    // Wait for the endpoint event before proceeding
    const endpointPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for SSE endpoint event')), 10_000);
      const wrappedResolve = (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      };
      // Store temporarily so pump can call it
      (this as unknown as Record<string, unknown>)._endpointResolver = wrappedResolve;
      (this as unknown as Record<string, unknown>)._endpointRejector = reject;
    });

    // Start background pump
    this.pump().then(() => {
      // SSE stream closed cleanly (e.g., server idle timeout) — reject all pending
      const dropErr = new Error('SSE stream closed (server may have timed out idle connection)');
      for (const { reject } of this.pending.values()) {
        reject(dropErr);
      }
      this.pending.clear();
      this.endpoint = null; // Mark as disconnected so callTool throws immediately
    }).catch((err) => {
      // SSE stream dropped with error — reject all pending requests
      for (const { reject } of this.pending.values()) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
      this.endpoint = null; // Mark as disconnected
    });

    this.endpoint = await endpointPromise;

    // Send initialize request
    const initId = this.nextId++;
    const initResponsePromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(initId, { resolve, reject });
    });

    await this.post({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'auto-turnoff', version: '1.0.0' },
        capabilities: {},
      },
    });

    await initResponsePromise;

    // Send notifications/initialized (no id, no response expected)
    await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.endpoint) {
      throw new Error('McpClient is not connected. Call connect() first.');
    }

    const id = this.nextId++;

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for tool response: ${name} (id=${id})`));
      }, 30_000);

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

    await this.post({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    const response = await responsePromise as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message?: string; code?: number };
    };

    if (response.error) {
      throw new Error(`MCP tool error [${name}]: ${response.error.message ?? JSON.stringify(response.error)}`);
    }

    const text = response.result?.content?.[0]?.text;
    if (text === undefined) {
      throw new Error(`Unexpected MCP response shape for tool ${name}: ${JSON.stringify(response)}`);
    }

    return JSON.parse(text) as T;
  }

  async close(): Promise<void> {
    const err = new Error('McpClient closed');

    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();

    try {
      await this.reader?.cancel();
    } catch {
      // ignore
    }

    this.abortController?.abort();
    this.reader = null;
    this.abortController = null;
    this.endpoint = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async post(body: unknown): Promise<void> {
    if (!this.endpoint) {
      throw new Error('No endpoint URL — SSE endpoint event not yet received.');
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

  private async pump(): Promise<void> {
    if (!this.reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await this.reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines (\n\n)
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.dispatchEvent(block);
      }
    }
  }

  private dispatchEvent(block: string): void {
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
      // Resolve the endpoint promise set up in connect()
      const resolver = (this as unknown as Record<string, unknown>)._endpointResolver as
        | ((url: string) => void)
        | undefined;
      if (resolver) {
        resolver(data);
        delete (this as unknown as Record<string, unknown>)._endpointResolver;
        delete (this as unknown as Record<string, unknown>)._endpointRejector;
      }
      return;
    }

    if (!data) return;

    let msg: { id?: number; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      // Not a JSON-RPC message — ignore
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg);
    }
  }
}
