import { PROVIDER_THRESHOLDS, DEFAULT_THRESHOLD, PRODUCT_THRESHOLDS, getWorkspaceConfig } from './config';
import type { CampaignDetail } from './types';

/** Minimal API interface used by threshold resolution (works with both MCP and direct clients) */
export interface ThresholdApi {
  listAccounts(workspaceId: string, tagIds: string): Promise<Array<{ email?: string; provider_code?: number; [key: string]: unknown }>>;
  getAccount(workspaceId: string, email: string): Promise<{ provider_code?: number; [key: string]: unknown }>;
}

/**
 * Resolve the kill threshold for a campaign.
 * Returns null if the workspace is not monitored.
 */
export async function resolveThreshold(
  workspaceId: string,
  campaign: CampaignDetail,
  api: ThresholdApi,
  kv: KVNamespace,
): Promise<number | null> {
  const config = getWorkspaceConfig(workspaceId);
  if (!config) return null;

  if (config.product === 'FUNDING') {
    return getInfraThreshold(workspaceId, campaign, api, kv);
  }

  return PRODUCT_THRESHOLDS[config.product];
}

/**
 * For Funding campaigns: resolve provider_code -> threshold via email_tag_list.
 * Caches result in KV for 7 days.
 */
export async function getInfraThreshold(
  workspaceId: string,
  campaign: CampaignDetail,
  api: ThresholdApi,
  kv: KVNamespace,
): Promise<number> {
  const cacheKey = `infra:${campaign.id}`;

  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    return parseInt(cached, 10);
  }

  const tagList = campaign.email_tag_list ?? [];
  if (tagList.length === 0) {
    console.warn(`[auto-turnoff] Campaign ${campaign.name} (${campaign.id}) has no email_tag_list. Using default threshold ${DEFAULT_THRESHOLD}.`);
    return DEFAULT_THRESHOLD;
  }

  const providerCodes = new Set<number>();
  for (const tagId of tagList) {
    // list_accounts doesn't return provider_code, so grab the first email
    // and call get_account on it to get the provider_code for this tag.
    const accounts = await api.listAccounts(workspaceId, tagId);
    if (accounts.length > 0 && accounts[0].email) {
      const detail = await api.getAccount(workspaceId, accounts[0].email);
      if (detail.provider_code !== undefined && detail.provider_code !== null) {
        providerCodes.add(detail.provider_code);
      }
    }
  }

  if (providerCodes.size === 0) {
    console.warn(`[auto-turnoff] No provider_code found for campaign ${campaign.name} (${campaign.id}). Using default threshold ${DEFAULT_THRESHOLD}.`);
    return DEFAULT_THRESHOLD;
  }

  let threshold: number;
  const codes = Array.from(providerCodes);

  if (codes.length === 1) {
    threshold = PROVIDER_THRESHOLDS[codes[0]] ?? DEFAULT_THRESHOLD;
  } else {
    const thresholds = codes.map((code) => PROVIDER_THRESHOLDS[code] ?? DEFAULT_THRESHOLD);
    threshold = Math.round(thresholds.reduce((a, b) => a + b, 0) / thresholds.length);
    console.warn(
      `[auto-turnoff] Mixed infrastructure on campaign ${campaign.name}: providers=[${codes.join(',')}], using averaged threshold ${threshold}`,
    );
  }

  await kv.put(cacheKey, String(threshold), { expirationTtl: 604800 });

  return threshold;
}
