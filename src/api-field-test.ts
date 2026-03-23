/**
 * One-shot test: Call GET /api/v2/campaigns/analytics directly and dump
 * the raw field names to confirm what the Instantly API actually returns.
 *
 * Deploy: npx wrangler deploy src/api-field-test.ts --name api-field-test --compatibility-date 2025-03-15
 * Hit:    https://api-field-test.sdultsin.workers.dev/__test
 * Delete: npx wrangler delete --name api-field-test
 */

interface Env {
  INSTANTLY_API_KEYS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/__test') {
      return new Response('GET /__test', { status: 200 });
    }

    const keyMap = JSON.parse(env.INSTANTLY_API_KEYS) as Record<string, string>;
    // Get first available key
    const [workspace, apiKey] = Object.entries(keyMap)[0];

    // Call the raw v2 analytics endpoint
    const apiUrl = new URL('https://api.instantly.ai/api/v2/campaigns/analytics');
    const res = await fetch(apiUrl.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: res.status, body: await res.text() }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = await res.json();

    // Extract first campaign and dump ALL field names + values
    const campaigns = Array.isArray(raw) ? raw : (raw as any).items ?? [];
    const first = campaigns[0] ?? {};
    const fieldNames = Object.keys(first);

    return new Response(JSON.stringify({
      workspace,
      total_campaigns: campaigns.length,
      raw_field_names: fieldNames,
      first_campaign_raw: first,
      // Also show second campaign for comparison
      second_campaign_raw: campaigns[1] ?? null,
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
