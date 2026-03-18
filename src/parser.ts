import { CM_CHANNEL_MAP } from './config';

/**
 * Extract a CM name from a campaign title.
 *
 * Strategy (in order):
 *  1. Find all parenthesized tokens in the title.
 *  2. Remove any that are exactly "copy" (case-insensitive).
 *  3. Take the LAST remaining token — this is the CM name.
 *  4. If no parenthesized tokens remain, fall back to splitting on " - " and
 *     checking whether the last segment (trimmed + uppercased) is a known CM.
 *  5. Normalize to uppercase.
 *  6. Return null if nothing valid is found.
 */
export function parseCmName(campaignName: string): string | null {
  // Step 1-3: parenthesized extraction.
  const parenMatches = [...campaignName.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const filtered = parenMatches.filter((v) => v.trim().toLowerCase() !== 'copy');

  if (filtered.length > 0) {
    return filtered[filtered.length - 1].trim().toUpperCase();
  }

  // Step 4: fallback — last segment of " - " split.
  const segments = campaignName.split(' - ');
  if (segments.length > 1) {
    const last = segments[segments.length - 1].trim().toUpperCase();
    if (last in CM_CHANNEL_MAP) {
      return last;
    }
  }

  return null;
}

/**
 * Extract a CM name and return the corresponding Slack channel ID.
 * Falls back to fallbackChannel if no CM can be identified.
 */
export function parseCmChannel(campaignName: string, fallbackChannel: string): string {
  const cm = parseCmName(campaignName);
  if (cm !== null && cm in CM_CHANNEL_MAP) {
    return CM_CHANNEL_MAP[cm];
  }
  return fallbackChannel;
}
