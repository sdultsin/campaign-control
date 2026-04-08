import type { Workspace, Campaign, CampaignDetail, StepAnalytics } from './types';
import { WORKSPACE_CONFIGS, STALE_ANALYTICS_RATIO_THRESHOLD, STALE_ANALYTICS_MIN_AGGREGATE_SENT } from './config';

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
    this.keyMap = new Map(Object.entries(parsed));
  }

  private getKey(workspaceId: string): string {
    // workspaceId is a slug like "the-dyad". Try direct lookup first.
    let key = this.keyMap.get(workspaceId);
    if (key) return key;

    // Fallback: look up by display name from WORKSPACE_CONFIGS
    const config = WORKSPACE_CONFIGS.find((c) => c.id === workspaceId);
    if (config) {
      key = this.keyMap.get(config.name);
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

  async getCampaigns(workspaceId: string): Promise<Campaign[]> {
    const key = this.getKey(workspaceId);
    // Instantly v2: status=1 means active (number, not string)
    const raw = await this.get<unknown>('/campaigns', key, {
      status: '1',
      limit: '100',
    });
    return this.extractArray<Campaign>(raw);
  }

  async getCampaignDetails(workspaceId: string, campaignId: string): Promise<CampaignDetail> {
    const key = this.getKey(workspaceId);
    // Returns campaign object directly (not wrapped)
    return this.get<CampaignDetail>(`/campaigns/${campaignId}`, key);
  }

  async getStepAnalytics(workspaceId: string, campaignId: string, startDate?: string, endDate?: string): Promise<StepAnalytics[]> {
    const key = this.getKey(workspaceId);
    // Returns bare array directly
    const params: Record<string, string> = {
      campaign_id: campaignId,
      include_opportunities_count: 'true',
    };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    const raw = await this.get<unknown>(
      '/campaigns/analytics/steps',
      key,
      params,
    );
    return this.extractArray<StepAnalytics>(raw);
  }

  async countLeads(workspaceId: string, campaignId: string): Promise<{
    total_leads: number;
    status: { completed: number; active: number; skipped: number; bounced: number; unsubscribed: number };
  }> {
    const key = this.getKey(workspaceId);
    // Instantly v2 has no /leads/count endpoint (404 — routes to /leads/:id).
    // Use /leads with limit=0 to get pagination metadata.
    try {
      const raw = await this.get<Record<string, unknown>>('/leads', key, {
        campaign_id: campaignId,
        limit: '0',
      });
      const totalLeads = (raw.total_count as number) ?? (raw.total as number) ?? 0;
      if (totalLeads > 0) {
        return {
          total_leads: totalLeads,
          status: { completed: 0, active: 0, skipped: 0, bounced: 0, unsubscribed: 0 },
        };
      }
    } catch {
      // Endpoint may not support limit=0, fall through
    }

    // Fallback: return zero — leads monitor will skip this campaign
    console.warn(`[instantly-direct] countLeads fallback for ${campaignId} — no direct endpoint`);
    return { total_leads: 0, status: { completed: 0, active: 0, skipped: 0, bounced: 0, unsubscribed: 0 } };
  }

  async getCampaignAnalytics(workspaceId: string, campaignId: string): Promise<{
    contacted: number; sent: number;
  }> {
    const key = this.getKey(workspaceId);
    const raw = await this.get<Record<string, unknown>>('/campaigns/analytics', key, { campaign_id: campaignId });
    // Response could be { campaigns: [{...}] } or direct object
    if (Array.isArray((raw as any).campaigns) && (raw as any).campaigns.length > 0) {
      const c = (raw as any).campaigns[0];
      return { contacted: c.contacted ?? 0, sent: c.sent ?? 0 };
    }
    return { contacted: (raw.contacted as number) ?? 0, sent: (raw.sent as number) ?? 0 };
  }

  async listAccounts(workspaceId: string, tagIds: string): Promise<Array<{
    email?: string; provider_code?: number; [key: string]: unknown;
  }>> {
    const key = this.getKey(workspaceId);
    const raw = await this.get<unknown>('/accounts', key, { tag_ids: tagIds });
    return this.extractArray(raw);
  }

  async getAccount(workspaceId: string, email: string): Promise<{
    provider_code?: number; [key: string]: unknown;
  }> {
    const key = this.getKey(workspaceId);
    const raw = await this.get<Record<string, unknown>>(`/accounts/${encodeURIComponent(email)}`, key);
    if ('account' in raw) return raw.account as any;
    return raw;
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
   * Batch fetch campaign analytics for all campaigns in a workspace.
   * Returns a Map<campaignId, analytics> for O(1) lookups.
   * ONE call per workspace — replaces N serial MCP calls.
   */
  async getBatchCampaignAnalytics(workspaceId: string): Promise<Map<string, {
    leads_count: number;
    new_leads_contacted_count: number;
    contacted: number;
    completed_count: number;
    bounced_count: number;
    unsubscribed_count: number;
  }>> {
    const key = this.getKey(workspaceId);
    const raw = await this.get<Record<string, unknown>>('/campaigns/analytics', key);
    const result = new Map<string, {
      leads_count: number;
      new_leads_contacted_count: number;
      contacted: number;
      completed_count: number;
      bounced_count: number;
      unsubscribed_count: number;
    }>();

    // Response shape: bare array [{campaign_id, leads_count, new_leads_contacted_count, ...}]
    const campaigns = this.extractArray<Record<string, unknown>>(raw);
    for (const c of campaigns) {
      const id = (c.campaign_id ?? c.id) as string;
      if (!id) continue;
      const newLeadsContacted = (c.new_leads_contacted_count as number) ?? (c.contacted_count as number) ?? 0;
      result.set(id, {
        leads_count: (c.leads_count as number) ?? 0,
        new_leads_contacted_count: newLeadsContacted,
        contacted: newLeadsContacted,
        completed_count: (c.completed_count as number) ?? 0,
        bounced_count: (c.bounced_count as number) ?? 0,
        unsubscribed_count: (c.unsubscribed_count as number) ?? 0,
      });
    }
    return result;
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

  /**
   * Cross-validate step analytics freshness for a campaign.
   * Compares sum of step-level sent counts against the campaign-level aggregate sent.
   * Returns { isStale: boolean, stepTotal: number, aggregateTotal: number, ratio: number }.
   * If aggregate sent is below STALE_ANALYTICS_MIN_AGGREGATE_SENT, returns isStale: false
   * (new campaigns with few sends are exempt from this check).
   */
  async checkAnalyticsFreshness(
    workspaceId: string,
    campaignId: string,
    stepAnalytics: StepAnalytics[],
  ): Promise<{ isStale: boolean; stepTotal: number; aggregateTotal: number; ratio: number }> {
    const key = this.getKey(workspaceId);

    let aggregateSent = 0;
    try {
      const raw = await this.get<Record<string, unknown>>(
        '/campaigns/analytics',
        key,
        { campaign_id: campaignId },
      );
      // Response: { campaigns: [{ sent, ... }] } or direct object
      if (Array.isArray((raw as any).campaigns) && (raw as any).campaigns.length > 0) {
        aggregateSent = (raw as any).campaigns[0].sent ?? (raw as any).campaigns[0].contacted ?? 0;
      } else {
        aggregateSent = (raw.sent as number) ?? (raw.contacted as number) ?? 0;
      }
    } catch (e) {
      console.warn(`[stale-guard] Failed to fetch aggregate analytics for ${campaignId}: ${e}`);
      // Can't verify - treat as fresh to avoid blocking all kills on API error
      return { isStale: false, stepTotal: 0, aggregateTotal: 0, ratio: 1 };
    }

    const stepTotal = stepAnalytics
      .filter((r) => r.step !== null && r.step !== undefined && r.step !== 'null')
      .reduce((sum, r) => sum + (r.sent ?? 0), 0);

    // Exempt: aggregate too low to be meaningful
    if (aggregateSent < STALE_ANALYTICS_MIN_AGGREGATE_SENT) {
      return { isStale: false, stepTotal, aggregateTotal: aggregateSent, ratio: 1 };
    }

    const ratio = aggregateSent > 0 ? stepTotal / aggregateSent : 1;
    const isStale = ratio < STALE_ANALYTICS_RATIO_THRESHOLD;

    return { isStale, stepTotal, aggregateTotal: aggregateSent, ratio };
  }
}
