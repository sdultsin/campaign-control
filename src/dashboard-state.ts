import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry, LeadsAuditEntry, DashboardItemType, DashboardSeverity, WinnerEntry, WarningDetail } from './types';
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
 * - approaching: WarningDetail[] for variants at 80%+ of kill threshold
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
  disabledKills: AuditEntry[] = [],
  dryRunKills: AuditEntry[] = [],
  winners: WinnerEntry[] = [],
  approaching: WarningDetail[] = [],
  frozenSteps: Array<{
    campaignId: string; campaignName: string; workspaceId: string; workspaceName: string;
    stepIndex: number; cm: string | null; frozenAt: string; variantCount: number;
    reenabledVariants: number[]; reason: string;
  }> = [],
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
      `${issue.campaign_id}:${issue.item_type}:${issue.step ?? 'null'}:${issue.variant ?? 'null'}`
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
        effective_threshold: entry.trigger.effective_threshold ?? entry.trigger.threshold,
        rule: entry.trigger.rule,
        surviving_variants: entry.safety.survivingVariants,
      },
    });
  }

  // Confirmed kills -> CRITICAL dashboard items
  for (const entry of disabledKills) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'DISABLED',
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
        effective_threshold: entry.trigger.effective_threshold ?? entry.trigger.threshold,
        rule: entry.trigger.rule,
      },
    });
  }

  // DRY_RUN kills -> CRITICAL dashboard items (review before going live)
  for (const entry of dryRunKills) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'DRY_RUN_KILL',
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
        effective_threshold: entry.trigger.effective_threshold ?? entry.trigger.threshold,
        rule: entry.trigger.rule,
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
        uncontacted: entry.leads.active_in_sequence,
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
        uncontacted: entry.leads.active_in_sequence,
        active: entry.leads.active,
        daily_limit: entry.leads.dailyLimit,
      },
    });
  }

  // WINNING -> INFO dashboard items
  for (const entry of winners) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'WINNING',
      severity: 'INFO',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaignName,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspaceName,
      step: entry.stepIndex + 1,
      variant: entry.variantIndex,
      variant_label: entry.variantLabel,
      context: {
        sent: entry.sent,
        opportunities: entry.opportunities,
        ratio: entry.ratio,
        winner_threshold: entry.winnerThreshold,
        kill_threshold: entry.killThreshold,
        is_off: entry.isOff,
      },
    });
  }

  // APPROACHING -> WARNING dashboard items (variants at 80%+ of kill threshold)
  for (const entry of approaching) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'APPROACHING',
      severity: 'WARNING',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaignName,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspaceName,
      step: entry.stepIndex + 1,
      variant: entry.variantIndex,
      variant_label: entry.variantLabel,
      context: {
        sent: entry.sent,
        threshold: entry.threshold,
        pct_consumed: entry.pctConsumed,
        opportunities: entry.opportunities,
        is_off: entry.isOff,
      },
    });
  }

  // STEP_FROZEN -> CRITICAL dashboard items (uniform underperformance - all variants failed)
  for (const entry of frozenSteps) {
    if (!entry.cm) continue;
    addIssue({
      item_type: 'STEP_FROZEN',
      severity: 'CRITICAL',
      cm: entry.cm,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaignName,
      workspace_id: entry.workspaceId,
      workspace_name: entry.workspaceName,
      step: entry.stepIndex + 1,
      variant: null,
      variant_label: null,
      context: {
        frozen_at: entry.frozenAt,
        variant_count: entry.variantCount,
        reenabled_variants: entry.reenabledVariants,
        reason: entry.reason,
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
