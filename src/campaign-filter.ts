import { WARM_LEADS_THRESHOLD } from './config';

/** Campaign name starts with OFF (optionally preceded by emojis/spaces) */
export function isOffCampaign(name: string): boolean {
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF[\s\-]/iu.test(name);
}

/** Campaign name starts with OLD (optionally preceded by emojis/spaces) */
export function isOldCampaign(name: string): boolean {
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OLD([\s\-]|$)/iu.test(name);
}

/** Campaign has fewer than WARM_LEADS_THRESHOLD lifetime contacted - warm list, not cold outreach */
export function isWarmLeadsCampaign(contacted: number): boolean {
  return contacted < WARM_LEADS_THRESHOLD;
}

/** Step 1 sent exceeds contacted by >10% - data from Instantly API is unreliable */
export function hasDataIntegrityIssue(step1TotalSent: number, contactedCount: number): boolean {
  return contactedCount > 0 && step1TotalSent > contactedCount * 1.1;
}
