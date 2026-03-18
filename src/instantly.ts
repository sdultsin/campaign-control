import { McpClient } from './mcp-client';
import type { Workspace, Campaign, StepAnalytics, CampaignDetail } from './types';

export class InstantlyApi {
  constructor(private mcp: McpClient) {}

  async listWorkspaces(): Promise<Workspace[]> {
    const raw = await this.mcp.callTool<unknown>('list_workspaces', {});
    console.log('[auto-turnoff] list_workspaces raw response:', JSON.stringify(raw).slice(0, 500));
    return this.extractArray<Workspace>(raw, 'list_workspaces');
  }

  async getCampaigns(workspaceId: string): Promise<Campaign[]> {
    const raw = await this.mcp.callTool<unknown>('get_campaigns', {
      workspace_id: workspaceId,
      status: 'active',
      limit: 100,
    });
    return this.extractArray<Campaign>(raw, 'get_campaigns');
  }

  async getStepAnalytics(workspaceId: string, campaignId: string): Promise<StepAnalytics[]> {
    const raw = await this.mcp.callTool<unknown>('get_step_analytics', {
      workspace_id: workspaceId,
      campaign_id: campaignId,
      include_opportunities: true,
    });
    return this.extractArray<StepAnalytics>(raw, 'get_step_analytics');
  }

  async getCampaignDetails(workspaceId: string, campaignId: string): Promise<CampaignDetail> {
    const raw = await this.mcp.callTool<unknown>('get_campaign_details', {
      workspace_id: workspaceId,
      campaign_id: campaignId,
    });
    // Campaign details might be wrapped in an object too
    if (Array.isArray(raw)) return raw[0] as CampaignDetail;
    if (raw && typeof raw === 'object' && 'id' in (raw as Record<string, unknown>)) return raw as CampaignDetail;
    // Try common wrapper keys
    const obj = raw as Record<string, unknown>;
    for (const key of ['campaign', 'data', 'result']) {
      if (obj[key] && typeof obj[key] === 'object') return obj[key] as CampaignDetail;
    }
    console.log('[auto-turnoff] get_campaign_details unexpected shape:', JSON.stringify(raw).slice(0, 500));
    return raw as CampaignDetail;
  }

  private extractArray<T>(raw: unknown, toolName: string): T[] {
    if (Array.isArray(raw)) return raw as T[];
    if (raw && typeof raw === 'object') {
      // Try common wrapper keys: { workspaces: [...] }, { campaigns: [...] }, { data: [...] }, etc.
      const obj = raw as Record<string, unknown>;
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) return val as T[];
      }
    }
    console.warn(`[auto-turnoff] ${toolName}: could not extract array from response:`, JSON.stringify(raw).slice(0, 500));
    return [];
  }

  async countLeads(workspaceId: string, campaignId: string): Promise<{ total_leads: number; status: { completed: number; active: number; skipped: number; bounced: number } }> {
    const raw = await this.mcp.callTool<unknown>('count_leads', {
      workspace_id: workspaceId,
      campaign_id: campaignId,
    });
    // count_leads returns an object, not an array
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      return {
        total_leads: (obj.total_leads as number) ?? 0,
        status: (obj.status as { completed: number; active: number; skipped: number; bounced: number }) ?? { completed: 0, active: 0, skipped: 0, bounced: 0 },
      };
    }
    console.warn(`[auto-turnoff] count_leads unexpected shape: ${JSON.stringify(raw).slice(0, 500)}`);
    return { total_leads: 0, status: { completed: 0, active: 0, skipped: 0, bounced: 0 } };
  }

  async listAccounts(workspaceId: string, tagIds: string): Promise<Array<{ email?: string; provider_code?: number; [key: string]: unknown }>> {
    const raw = await this.mcp.callTool<unknown>('list_accounts', {
      workspace_id: workspaceId,
      tag_ids: tagIds,
    });
    return this.extractArray<{ email?: string; provider_code?: number; [key: string]: unknown }>(raw, 'list_accounts');
  }

  async getAccount(workspaceId: string, email: string): Promise<{ provider_code?: number; [key: string]: unknown }> {
    const raw = await this.mcp.callTool<unknown>('get_account', {
      workspace_id: workspaceId,
      email,
    });
    if (raw && typeof raw === 'object' && 'account' in (raw as Record<string, unknown>)) {
      return (raw as Record<string, unknown>).account as { provider_code?: number; [key: string]: unknown };
    }
    return raw as { provider_code?: number; [key: string]: unknown };
  }

  async enableVariant(
    workspaceId: string,
    campaign: CampaignDetail,
    stepIndex: number,
    variantIndex: number,
  ): Promise<boolean> {
    const cloned = structuredClone(campaign.sequences);
    cloned[0].steps[stepIndex].variants[variantIndex].v_disabled = false;

    await this.mcp.callTool<unknown>('update_campaign', {
      workspace_id: workspaceId,
      campaign_id: campaign.id,
      updates: { sequences: cloned },
    });

    // Verify the update took effect
    const verified = await this.getCampaignDetails(workspaceId, campaign.id);
    const isEnabled =
      verified.sequences?.[0]?.steps?.[stepIndex]?.variants?.[variantIndex]?.v_disabled !== true;

    if (!isEnabled) {
      console.warn(
        `[auto-turnoff] Rescan verification failed: variant not re-enabled after update. ` +
          `campaign=${campaign.id} step=${stepIndex} variant=${variantIndex}`,
      );
      return false;
    }

    return true;
  }

  async disableVariant(
    workspaceId: string,
    campaign: CampaignDetail,
    stepIndex: number,
    variantIndex: number,
  ): Promise<boolean> {
    const cloned = structuredClone(campaign.sequences);
    cloned[0].steps[stepIndex].variants[variantIndex].v_disabled = true;

    await this.mcp.callTool<unknown>('update_campaign', {
      workspace_id: workspaceId,
      campaign_id: campaign.id,
      updates: { sequences: cloned },
    });

    // Verify the update took effect
    const verified = await this.getCampaignDetails(workspaceId, campaign.id);
    const isDisabled =
      verified.sequences?.[0]?.steps?.[stepIndex]?.variants?.[variantIndex]?.v_disabled === true;

    if (!isDisabled) {
      console.warn(
        `[auto-turnoff] Verification failed: variant not disabled after update. ` +
          `campaign=${campaign.id} step=${stepIndex} variant=${variantIndex}`,
      );
      return false;
    }

    return true;
  }
}
