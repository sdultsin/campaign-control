import type { StepAnalytics, LeadsDepletionResult } from './types';

/**
 * Sum all variant sent counts for step index 0.
 * This equals "Sequence Started" in the Instantly UI:
 * the number of unique leads that received the first email.
 */
export function computeStep0Sent(allAnalytics: StepAnalytics[]): number {
  return allAnalytics
    .filter(a => parseInt(a.step, 10) === 0)
    .reduce((sum, a) => sum + a.sent, 0);
}

/**
 * Calculate uncontacted leads.
 * uncontacted = total_leads - step0_sent - bounced - skipped
 * Floors at 0 (cumulative step analytics can exceed total after lead recycling).
 */
export function computeUncontacted(
  totalLeads: number,
  step0Sent: number,
  bounced: number,
  skipped: number,
): number {
  return Math.max(0, totalLeads - step0Sent - bounced - skipped);
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
