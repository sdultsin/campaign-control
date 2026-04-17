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

/**
 * Parse a known CM from a campaign name. Only matches names in CM_CHANNEL_MAP
 * so foreign tokens like "(Ben's leads)" or "RG2848" are ignored.
 * Returns the CM key (uppercased) or null if no known CM is found.
 */
function parseCmFromName(campaignName: string): string | null {
  const knownCms = Object.keys(CM_CHANNEL_MAP);

  // Parentheses first. Reverse so the rightmost paren wins (it's the CM
  // tag by convention; earlier parens are usually lead-list metadata).
  const parenMatches = [...campaignName.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const filtered = parenMatches.filter((v) => v.trim().toLowerCase() !== 'copy');
  for (const match of filtered.reverse()) {
    const candidate = match.trim().toUpperCase();
    if (knownCms.includes(candidate)) return candidate;
  }

  // Suffix fallback (e.g. "Campaign Name - ALEX").
  const nameUpper = campaignName.toUpperCase();
  for (const cm of knownCms) {
    if (nameUpper.includes(`- ${cm}`) || nameUpper.endsWith(` ${cm}`)) {
      return cm;
    }
  }

  return null;
}

export function resolveCmName(
  workspaceConfig: WorkspaceConfig,
  campaignName: string,
): string | null {
  // Parse the name first, for both dedicated and shared workspaces. A CM
  // tag in the campaign name (e.g. "... (MARCOS)") is an explicit
  // attribution and must win over the workspace's defaultCm -- otherwise
  // overflow campaigns hosted in another CM's dedicated workspace get
  // misrouted to the workspace owner. The parser only matches names in
  // CM_CHANNEL_MAP, so unrelated parentheticals don't trigger false hits.
  const parsed = parseCmFromName(campaignName);
  if (parsed) return parsed;

  // No CM tag found. Dedicated workspace: fall back to the owner.
  if (workspaceConfig.defaultCm) return workspaceConfig.defaultCm;

  console.warn(`[CC] Unresolved CM for campaign: ${campaignName} in shared workspace`);
  return null;
}
