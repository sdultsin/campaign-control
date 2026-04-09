import type { Workspace, CampaignDetail } from './types';
import { WORKSPACE_CONFIGS } from './config';

/**
 * Direct Instantly API client — bypasses MCP SSE entirely.
 * Each workspace has its own API key. The key map is slug -> base64 API key.
 * No workspace_id query param needed — the API key IS the workspace scope.
 */
export class InstantlyDirectApi {
  private keyMap: Map<string, string>; // workspace slug -> API key
  private baseUrl = 'https://api.instantly.ai/api/v2';

  constructor(keyMapJson: string) {
    // Parse JSON map of workspace slug -> API key
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(keyMapJson) as Record<string, string>;
    } catch (e) {
      throw new Error(`[instantly-direct] Failed to parse INSTANTLY_API_KEYS JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Store keys with lowercase lookup for case-insensitive matching.
    // Instantly display names vary in casing ("Koi And Destroy" vs "Koi and Destroy").
    this.keyMap = new Map<string, string>();
    for (const [name, apiKey] of Object.entries(parsed)) {
      this.keyMap.set(name.toLowerCase(), apiKey);
    }
  }

  private getKey(workspaceId: string): string {
    // workspaceId is a slug like "the-dyad". Try direct lookup first.
    let key = this.keyMap.get(workspaceId.toLowerCase());
    if (key) return key;

    // Fallback: look up by display name from WORKSPACE_CONFIGS
    const config = WORKSPACE_CONFIGS.find((c) => c.id === workspaceId);
    if (config) {
      key = this.keyMap.get(config.name.toLowerCase());
      if (key) return key;
    }

    throw new Error(`[instantly-direct] No API key for workspace: ${workspaceId}`);
  }

  private async get<T>(path: string, apiKey: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    let res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    // Single retry with 2s backoff for rate-limit responses
    if (res.status === 429) {
      console.warn(`[instantly-direct] 429 rate-limited on GET ${path}, retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
      res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Instantly API ${res.status}: ${path} - ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, apiKey: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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

  /**
   * Extract array from API response. Instantly v2 wraps lists in { items: [...] }.
   * Also handles bare arrays and other wrapper keys.
   */
  private extractArray<T>(raw: unknown): T[] {
    if (Array.isArray(raw)) return raw as T[];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      // Prefer 'items' (Instantly v2 standard)
      if (Array.isArray(obj.items)) return obj.items as T[];
      // Fallback: any array value
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) return val as T[];
      }
    }
    return [];
  }

  /**
   * listWorkspaces — returns the configured workspaces.
   * Instantly API has no /workspaces endpoint. We validate each workspace
   * by its presence in the key map instead.
   */
  async listWorkspaces(): Promise<Workspace[]> {
    return WORKSPACE_CONFIGS
      .filter((c) => {
        try { this.getKey(c.id); return true; } catch { return false; }
      })
      .map((c) => ({ id: c.id, name: c.name }));
  }

  async getCampaignDetails(workspaceId: string, campaignId: string): Promise<CampaignDetail> {
    const key = this.getKey(workspaceId);
    // Returns campaign object directly (not wrapped)
    return this.get<CampaignDetail>(`/campaigns/${campaignId}`, key);
  }

  async enableVariant(
    workspaceId: string,
    campaign: CampaignDetail,
    stepIndex: number,
    variantIndex: number,
  ): Promise<boolean> {
    const key = this.getKey(workspaceId);
    const cloned = structuredClone(campaign.sequences);
    cloned[0].steps[stepIndex].variants[variantIndex].v_disabled = false;

    await this.patch(`/campaigns/${campaign.id}`, key, { sequences: cloned });

    const verified = await this.getCampaignDetails(workspaceId, campaign.id);
    return verified.sequences?.[0]?.steps?.[stepIndex]?.variants?.[variantIndex]?.v_disabled !== true;
  }

  async disableVariant(
    workspaceId: string,
    campaign: CampaignDetail,
    stepIndex: number,
    variantIndex: number,
  ): Promise<boolean> {
    const key = this.getKey(workspaceId);
    const cloned = structuredClone(campaign.sequences);
    cloned[0].steps[stepIndex].variants[variantIndex].v_disabled = true;

    await this.patch(`/campaigns/${campaign.id}`, key, { sequences: cloned });

    const verified = await this.getCampaignDetails(workspaceId, campaign.id);
    return verified.sequences?.[0]?.steps?.[stepIndex]?.variants?.[variantIndex]?.v_disabled === true;
  }

  /**
   * Update campaign (used for batch kill execution).
   */
  async updateCampaign(
    workspaceId: string,
    campaignId: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    const key = this.getKey(workspaceId);
    await this.patch(`/campaigns/${campaignId}`, key, updates);
  }

}
