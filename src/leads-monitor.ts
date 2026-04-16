import type { LeadsDepletionResult } from './types';
import { LEADS_EXHAUSTED_THRESHOLD, LEADS_WARNING_THRESHOLD } from './config';

/**
 * Evaluate a campaign's lead depletion status using absolute thresholds.
 *
 * Returns:
 * - SKIPPED if totalLeads <= 0
 * - EXHAUSTED if uncontacted <= LEADS_EXHAUSTED_THRESHOLD (100)
 * - WARNING if uncontacted < LEADS_WARNING_THRESHOLD (10000)
 * - HEALTHY otherwise
 *
 * Canonical `uncontacted` = `total_leads - lead_sequence_started`,
 * per the 2026-04-16 column rename. Do NOT substitute analytics_sequence_started.
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
