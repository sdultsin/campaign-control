import {
  DEFAULT_THRESHOLD,
  PRODUCT_THRESHOLDS,
  PROVIDER_THRESHOLDS,
  OFF_CAMPAIGN_BUFFER,
  OUTLOOK_KPI_WORKSPACES,
  getWorkspaceConfig,
} from './config';
import { infraTypeToThreshold } from './pipeline-data';

/**
 * Resolve the kill threshold for a campaign.
 *
 * New flow (Pipeline migration): uses infra_type from campaign_data instead of
 * Instantly API tag lookups. Existing KV cache (7-day TTL) preserves
 * previously-resolved thresholds during the transition.
 *
 * Returns null if the workspace is not monitored.
 */
export async function resolveThreshold(
  workspaceId: string,
  campaignId: string,
  infraType: string | null,
  kv: KVNamespace,
  isOff: boolean = false,
): Promise<number | null> {
  const config = getWorkspaceConfig(workspaceId);
  if (!config) return null;

  let threshold: number;
  if (config.product === 'FUNDING') {
    if (OUTLOOK_KPI_WORKSPACES.has(workspaceId)) {
      threshold = PROVIDER_THRESHOLDS[3]; // Force Outlook threshold regardless of infra_type
    } else {
      threshold = await getInfraThreshold(campaignId, infraType, kv);
    }
  } else {
    threshold = PRODUCT_THRESHOLDS[config.product];
  }

  if (isOff) {
    threshold = Math.round(threshold * OFF_CAMPAIGN_BUFFER);
  }

  return threshold;
}

/**
 * For Funding campaigns: resolve infra_type -> threshold.
 * Checks KV cache first (preserves existing 7-day cached values from
 * the old provider_code-based detection). Falls back to infra_type lookup.
 */
async function getInfraThreshold(
  campaignId: string,
  infraType: string | null,
  kv: KVNamespace,
): Promise<number> {
  const cacheKey = `infra:${campaignId}`;

  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    return parseInt(cached, 10);
  }

  const threshold = infraTypeToThreshold(infraType);

  if (infraType === null) {
    console.warn(
      `[auto-turnoff] Campaign ${campaignId} has null infra_type. Using default threshold ${DEFAULT_THRESHOLD}.`,
    );
  }

  await kv.put(cacheKey, String(threshold), { expirationTtl: 604800 });

  return threshold;
}
