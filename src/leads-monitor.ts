import type { LeadsDepletionResult } from './types';

/**
 * Calculate uncontacted leads.
 * Uses the "contacted" field from get_campaign_analytics (= "Sequence started" in UI).
 * uncontacted = total_leads - contacted
 */
export function computeUncontacted(
  totalLeads: number,
  contacted: number,
): number {
  return Math.max(0, totalLeads - contacted);
}

/**
 * Evaluate a campaign's lead depletion status.
 *
 * Returns:
 * - SKIPPED if totalLeads <= 0 or dailyLimit <= 0
 * - EXHAUSTED if uncontacted <= 0
 * - WARNING if uncontacted < dailyLimit (less than 1 day of leads)
 * - HEALTHY otherwise
 */
export function evaluateLeadDepletion(
  uncontacted: number,
  dailyLimit: number,
  totalLeads: number,
): LeadsDepletionResult {
  if (totalLeads <= 0 || dailyLimit <= 0) {
    return { status: 'SKIPPED', uncontacted, totalLeads, dailyLimit };
  }
  if (uncontacted <= 0) {
    return { status: 'EXHAUSTED', uncontacted: 0, totalLeads, dailyLimit };
  }
  if (uncontacted < dailyLimit) {
    return { status: 'WARNING', uncontacted, totalLeads, dailyLimit };
  }
  return { status: 'HEALTHY', uncontacted, totalLeads, dailyLimit };
}
