import type { LeadsDepletionResult } from './types';
import { LEADS_EXHAUSTED_THRESHOLD, LEADS_WARNING_THRESHOLD } from './config';

/**
 * Evaluate a campaign's lead depletion status using absolute thresholds.
 *
 * Returns:
 * - SKIPPED if totalLeads <= 0
 * - EXHAUSTED if uncontacted <= LEADS_EXHAUSTED_THRESHOLD (0)
 * - WARNING if uncontacted < LEADS_WARNING_THRESHOLD (5000)
 * - HEALTHY otherwise
 */
export function evaluateLeadDepletion(
  uncontacted: number,
  totalLeads: number,
): LeadsDepletionResult {
  if (totalLeads <= 0) {
    return { status: 'SKIPPED', uncontacted, totalLeads };
  }
  if (uncontacted <= LEADS_EXHAUSTED_THRESHOLD) {
    return { status: 'EXHAUSTED', uncontacted: 0, totalLeads };
  }
  if (uncontacted < LEADS_WARNING_THRESHOLD) {
    return { status: 'WARNING', uncontacted, totalLeads };
  }
  return { status: 'HEALTHY', uncontacted, totalLeads };
}
