import type { WorkspaceConfig } from './config';
import { CM_CHANNEL_MAP, CM_MONITOR_CHANNELS, PILOT_CMS, WORKSPACE_CM_EXCLUSIONS } from './config';

/**
 * Resolve the Slack channel for a notification based on the CM name.
 * Routes to the CM's dedicated monitor channel if they're in the pilot.
 * Falls back to the fallback channel if CM is unknown or unmapped.
 */
export function resolveChannel(
  cmName: string | null,
  fallbackChannel: string,
): string {
  if (cmName && CM_MONITOR_CHANNELS[cmName]) {
    return CM_MONITOR_CHANNELS[cmName];
  }
  return fallbackChannel;
}

/**
 * Check if a campaign belongs to a pilot CM.
 */
export function isPilotCampaign(cmName: string | null): boolean {
  if (PILOT_CMS.size === 0) return true; // empty set = no filter, full fleet
  if (!cmName) return false;
  return PILOT_CMS.has(cmName);
}

/**
 * Check if a dedicated workspace's default CM is in the pilot.
 * Returns false for shared workspaces (defaultCm === null) since
 * those need per-campaign CM resolution.
 */
export function isPilotWorkspace(config: WorkspaceConfig): boolean {
  if (PILOT_CMS.size === 0) return true;
  if (config.defaultCm === null) return true; // shared — must check per-campaign
  return PILOT_CMS.has(config.defaultCm);
}

/**
 * Resolve the CM name for audit logging.
 * For dedicated workspaces, returns the default CM.
 * For shared workspaces, parses from campaign title.
 */
/**
 * Check if a CM is excluded from monitoring in a specific workspace.
 * Used when a CM moves workspaces but old campaigns haven't been cleaned up.
 */
export function isExcludedFromWorkspace(workspaceId: string, cmName: string | null): boolean {
  if (!cmName) return false;
  return WORKSPACE_CM_EXCLUSIONS[workspaceId]?.has(cmName) ?? false;
}

export function resolveCmName(
  workspaceConfig: WorkspaceConfig,
  campaignName: string,
): string | null {
  // Dedicated workspace: owner is the defaultCm, period.
  // No campaign name parsing -- avoids false matches on lead list
  // labels, batch names, or other parenthetical metadata.
  if (workspaceConfig.defaultCm) return workspaceConfig.defaultCm;

  // Shared workspace: resolve CM from campaign name.
  // Check parentheses first -- must match a known CM.
  const knownCms = Object.keys(CM_CHANNEL_MAP);
  const parenMatches = [...campaignName.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const filtered = parenMatches.filter((v) => v.trim().toLowerCase() !== 'copy');
  for (const match of filtered.reverse()) {
    const candidate = match.trim().toUpperCase();
    if (knownCms.includes(candidate)) return candidate;
  }

  // Fallback: suffix parsing (e.g. "Campaign Name - ALEX")
  const nameUpper = campaignName.toUpperCase();
  for (const cm of knownCms) {
    if (nameUpper.includes(`- ${cm}`) || nameUpper.endsWith(` ${cm}`)) {
      return cm;
    }
  }

  console.warn(`[CC] Unresolved CM for campaign: ${campaignName} in shared workspace`);
  return null;
}
