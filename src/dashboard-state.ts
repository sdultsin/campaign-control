import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry, LeadsAuditEntry, DashboardItemType, DashboardSeverity } from './types';
import { upsertDashboardItem, resolveStaleItems } from './supabase';
import { PILOT_CMS } from './config';

interface DetectedIssue {
  item_type: DashboardItemType;
  severity: DashboardSeverity;
  cm: string;
  campaign_id: string;
  campaign_name: string;
  workspace_id: string;
  workspace_name: string;
  step: number | null;
  variant: number | null;
  variant_label: string | null;
  context: Record<string, unknown>;
}

/**
 * Build dashboard state from the current run's evaluation results.
 *
 * Called after all phases complete. Receives:
 * - blockedActions: AuditEntry[] where action = 'BLOCKED' from this run
 * - leadsExhausted: LeadsAuditEntry[] where action = 'LEADS_EXHAUSTED' from this run
 * - leadsWarnings: LeadsAuditEntry[] where action = 'LEADS_WARNING' from this run
 *
 * For each issue: upsert to dashboard_items (update last_scan_at if existing).
 * For items in dashboard_items NOT found in this scan: mark resolved, write resolution_log.
 */
export async function buildDashboardState(
  sb: SupabaseClient,
  scanTimestamp: string,
  blockedActions: AuditEntry[],
  leadsExhausted: LeadsAuditEntry[],
  leadsWarnings: LeadsAuditEntry[],
): Promise<{ upserted: number; resolved: number }> {
  // Collect all detected issues, keyed by CM
  const issuesByCm = new Map<string, DetectedIssue[]>();
  const activeKeysByCm = new Map<string, Set<string>>();

  function addIssue(issue: DetectedIssue): void {
    if (!issue.cm) return; // skip campaigns with no CM assignment
    if (!issuesByCm.has(issue.cm)) issuesByCm.set(issue.cm, []);
    if (!activeKeysByCm.has(issue.cm)) activeKeysByCm.set(issue.cm, new Set());
    issuesByCm.get(issue.cm)!.push(issue);
    activeKeysByCm.get(issue.cm)!.add(
      `${issue.campaign_id}:${issue.item_type}:${issue.step ?? 'null'}`
    );
  }

  // BLOCKED actions -> CRITICAL dashboard items
  for (const entry of blockedActions) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'BLOCKED',
      severity: 'CRITICAL',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaign,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspace,
      step: entry.step,
      variant: entry.variant,
      variant_label: entry.variantLabel,
      context: {
        sent: entry.trigger.sent,
        opportunities: entry.trigger.opportunities,
        ratio: entry.trigger.ratio,
        threshold: entry.trigger.threshold,
        rule: entry.trigger.rule,
        surviving_variants: entry.safety.survivingVariants,
      },
    });
  }

  // LEADS_EXHAUSTED -> CRITICAL dashboard items
  for (const entry of leadsExhausted) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'LEADS_EXHAUSTED',
      severity: 'CRITICAL',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaign,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspace,
      step: null,
      variant: null,
      variant_label: null,
      context: {
        total: entry.leads.total,
        contacted: entry.leads.contacted,
        uncontacted: entry.leads.uncontacted,
        active: entry.leads.active,
        daily_limit: entry.leads.dailyLimit,
      },
    });
  }

  // LEADS_WARNING -> WARNING dashboard items
  for (const entry of leadsWarnings) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'LEADS_WARNING',
      severity: 'WARNING',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaign,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspace,
      step: null,
      variant: null,
      variant_label: null,
      context: {
        total: entry.leads.total,
        uncontacted: entry.leads.uncontacted,
        active: entry.leads.active,
        daily_limit: entry.leads.dailyLimit,
      },
    });
  }

  // Upsert all detected issues
  let upserted = 0;
  for (const [_cm, issues] of issuesByCm) {
    for (const issue of issues) {
      await upsertDashboardItem(sb, issue);
      upserted++;
    }
  }

  // Resolve items that are no longer detected
  // Only resolve for CMs that were actually scanned in this run (pilot CMs)
  let totalResolved = 0;
  for (const cm of PILOT_CMS) {
    const activeKeys = activeKeysByCm.get(cm) ?? new Set();
    const resolved = await resolveStaleItems(sb, cm, activeKeys, scanTimestamp);
    totalResolved += resolved;
  }

  return { upserted, resolved: totalResolved };
}
