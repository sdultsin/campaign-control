import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry, LeadsAuditEntry, RunSummary, DailySnapshot } from './types';

let client: SupabaseClient | null = null;

export function getSupabaseClient(url: string, key: string): SupabaseClient {
  if (!client) {
    client = createClient(url, key);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Fire-and-forget write helpers
// ---------------------------------------------------------------------------

export async function writeAuditLogToSupabase(
  sb: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await sb.from('audit_logs').insert({
    timestamp: entry.timestamp,
    action: entry.action,
    workspace: entry.workspace,
    workspace_id: entry.workspaceId,
    campaign: entry.campaign,
    campaign_id: entry.campaignId,
    step: entry.step,
    variant: entry.variant,
    variant_label: entry.variantLabel,
    cm: entry.cm,
    product: entry.product,
    trigger_sent: entry.trigger.sent,
    trigger_opportunities: entry.trigger.opportunities,
    trigger_ratio: entry.trigger.ratio,
    trigger_threshold: entry.trigger.threshold,
    trigger_rule: entry.trigger.rule,
    safety_surviving_variants: entry.safety.survivingVariants,
    safety_notification: entry.safety.notification,
    dry_run: entry.dryRun,
  });
  if (error) console.error(`[supabase] audit_logs insert failed: ${error.message}`);
}

export async function writeLeadsAuditToSupabase(
  sb: SupabaseClient,
  entry: LeadsAuditEntry,
): Promise<void> {
  const { error } = await sb.from('leads_audit_logs').insert({
    timestamp: entry.timestamp,
    action: entry.action,
    workspace: entry.workspace,
    workspace_id: entry.workspaceId,
    campaign: entry.campaign,
    campaign_id: entry.campaignId,
    cm: entry.cm,
    leads_total: entry.leads.total,
    leads_uncontacted: entry.leads.uncontacted,
    leads_step0_sent: entry.leads.step0Sent,
    leads_bounced: entry.leads.bounced,
    leads_skipped: entry.leads.skipped,
    leads_daily_limit: entry.leads.dailyLimit,
    dry_run: entry.dryRun,
  });
  if (error) console.error(`[supabase] leads_audit_logs insert failed: ${error.message}`);
}

export async function writeRunSummaryToSupabase(
  sb: SupabaseClient,
  summary: RunSummary,
): Promise<void> {
  const { error } = await sb.from('run_summaries').insert({
    timestamp: summary.timestamp,
    workspaces_processed: summary.workspacesProcessed,
    campaigns_evaluated: summary.campaignsEvaluated,
    variants_disabled: summary.variantsDisabled,
    variants_blocked: summary.variantsBlocked,
    variants_warned: summary.variantsWarned,
    errors: summary.errors,
    duration_ms: summary.durationMs,
    rescan_checked: summary.rescanChecked,
    rescan_re_enabled: summary.rescanReEnabled,
    rescan_expired: summary.rescanExpired,
    rescan_cm_override: summary.rescanCmOverride,
    leads_checked: summary.leadsChecked,
    leads_warnings: summary.leadsWarnings,
    leads_exhausted: summary.leadsExhausted,
    leads_recovered: summary.leadsRecovered,
    dry_run: summary.dryRun,
  });
  if (error) console.error(`[supabase] run_summaries insert failed: ${error.message}`);
}

export async function writeDailySnapshotToSupabase(
  sb: SupabaseClient,
  snapshot: DailySnapshot,
): Promise<void> {
  const row = {
    date: snapshot.date,
    captured_at: snapshot.capturedAt,
    total_campaigns: snapshot.totalCampaigns,
    total_steps: snapshot.totalSteps,
    total_variants: snapshot.totalVariants,
    active_variants: snapshot.activeVariants,
    disabled_variants: snapshot.disabledVariants,
    above_threshold: snapshot.aboveThreshold,
    actions_disabled: snapshot.actionsToday.disabled,
    actions_blocked: snapshot.actionsToday.blocked,
    actions_warned: snapshot.actionsToday.warned,
    actions_re_enabled: snapshot.actionsToday.reEnabled,
    actions_expired: snapshot.actionsToday.expired,
    actions_cm_override: snapshot.actionsToday.cmOverride,
    by_workspace: snapshot.byWorkspace,
    by_cm: snapshot.byCm,
    campaign_health: snapshot.campaignHealth,
  };

  const { error } = await sb.from('daily_snapshots').upsert(row, {
    onConflict: 'date',
  });
  if (error) console.error(`[supabase] daily_snapshots upsert failed: ${error.message}`);
}

export interface NotificationRecord {
  timestamp: string;
  notification_type: string;
  channel_id: string;
  title: string;
  details: string;
  thread_ts: string | null;
  reply_success: boolean | null;
  campaign_id: string | null;
  campaign_name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  cm: string | null;
  step: number | null;
  variant: number | null;
  variant_label: string | null;
  dry_run: boolean;
}

export async function writeNotificationToSupabase(
  sb: SupabaseClient,
  record: NotificationRecord,
): Promise<void> {
  const { error } = await sb.from('notifications').insert(record);
  if (error) console.error(`[supabase] notifications insert failed: ${error.message}`);
}
