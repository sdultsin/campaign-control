import type { SupabaseClient } from '@supabase/supabase-js';
import { PROVIDER_THRESHOLDS, DEFAULT_THRESHOLD } from './config';

// ---------------------------------------------------------------------------
// Pipeline Supabase data types
// ---------------------------------------------------------------------------

export interface PipelineCampaign {
  id: string;       // campaign_id
  name: string;     // campaign_name
}

export interface PipelineVariantRow {
  step: number;      // 0-indexed (converted from 1-indexed pipeline data)
  variant: number;   // 0-indexed (converted from letter A=0, B=1, etc.)
  sent: number;      // emails_sent
  opportunities: number;
  v_disabled: boolean;
}

export interface PipelineCampaignMeta {
  daily_limit: number | null;
  infra_type: string | null;     // 'google' | 'outlook' | null
  contacted_count: number | null;
  total_leads: number | null;
  lead_sequence_started: number | null;
  leads_completed: number | null;
  leads_bounced: number | null;
  leads_unsubscribed: number | null;
}

// ---------------------------------------------------------------------------
// Replace: instantly.getCampaigns(workspaceId)
// Returns active campaigns for a workspace from Pipeline Supabase.
// ---------------------------------------------------------------------------

export async function getActiveCampaigns(
  sb: SupabaseClient,
  workspaceId: string,
  workspaceName?: string,
): Promise<PipelineCampaign[]> {
  // Pipeline Supabase has both slug ("renaissance-1") and display name ("Renaissance 1")
  // workspace_id formats. Query both to catch all campaigns.
  const wsIds = workspaceName && workspaceName !== workspaceId
    ? [workspaceId, workspaceName]
    : [workspaceId];

  const { data, error } = await sb
    .from('campaign_data')
    .select('campaign_id, campaign_name')
    .in('workspace_id', wsIds)
    .in('status', ['1', 'Active'])
    .neq('step', '__ALL__')
    .neq('variant', '__ALL__');

  if (error) {
    console.error(`[pipeline-data] getActiveCampaigns failed for ${workspaceId}: ${error.message}`);
    return [];
  }

  // Deduplicate by campaign_id (multiple rows per campaign: one per step/variant)
  const seen = new Map<string, PipelineCampaign>();
  for (const row of data ?? []) {
    if (!seen.has(row.campaign_id)) {
      seen.set(row.campaign_id, {
        id: row.campaign_id,
        name: row.campaign_name,
      });
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Replace: instantly.getStepAnalytics(workspaceId, campaignId)
// Returns per-variant analytics with CC-compatible 0-indexed step/variant.
// ---------------------------------------------------------------------------

export async function getVariantAnalytics(
  sb: SupabaseClient,
  campaignId: string,
): Promise<PipelineVariantRow[]> {
  const { data, error } = await sb
    .from('campaign_data')
    .select('step, variant, emails_sent, opportunities, v_disabled')
    .eq('campaign_id', campaignId)
    .neq('step', '__ALL__')
    .neq('variant', '__ALL__');

  if (error) {
    console.error(`[pipeline-data] getVariantAnalytics failed for ${campaignId}: ${error.message}`);
    return [];
  }

  return (data ?? []).map((row) => ({
    // Pipeline uses 1-indexed steps; CC uses 0-indexed
    step: parseInt(row.step as string, 10) - 1,
    // Pipeline uses letters (A, B, C...); CC uses 0-indexed numbers
    variant: (row.variant as string).charCodeAt(0) - 65,
    sent: (row.emails_sent as number) ?? 0,
    opportunities: (row.opportunities as number) ?? 0,
    v_disabled: (row.v_disabled as boolean) ?? false,
  }));
}

// ---------------------------------------------------------------------------
// Replace: instantly.getCampaignDetails() (eval path) +
//          instantly.getCampaignAnalytics() +
//          instantly.getBatchCampaignAnalytics() (per campaign)
// Returns campaign-level metadata from Pipeline Supabase.
// ---------------------------------------------------------------------------

export async function getCampaignMeta(
  sb: SupabaseClient,
  campaignId: string,
): Promise<PipelineCampaignMeta> {
  // Query 1: Get daily_limit and infra_type from any non-rollup row
  const { data: metaRows, error: metaErr } = await sb
    .from('campaign_data')
    .select('daily_limit, infra_type')
    .eq('campaign_id', campaignId)
    .neq('step', '__ALL__')
    .limit(1);

  if (metaErr) {
    console.error(`[pipeline-data] getCampaignMeta (meta) failed for ${campaignId}: ${metaErr.message}`);
  }

  // Query 2: Get leads data from the __ALL__/__ALL__ rollup row
  const { data: rollupRows, error: rollupErr } = await sb
    .from('campaign_data')
    .select('lead_sequence_started, total_leads, leads_completed, leads_bounced, leads_unsubscribed')
    .eq('campaign_id', campaignId)
    .eq('step', '__ALL__')
    .eq('variant', '__ALL__')
    .limit(1);

  if (rollupErr) {
    console.error(`[pipeline-data] getCampaignMeta (rollup) failed for ${campaignId}: ${rollupErr.message}`);
  }

  const meta = metaRows?.[0];
  const rollup = rollupRows?.[0];

  return {
    daily_limit: (meta?.daily_limit as number | null) ?? null,
    infra_type: (meta?.infra_type as string | null) ?? null,
    contacted_count: (rollup?.lead_sequence_started as number | null) ?? null,
    total_leads: (rollup?.total_leads as number | null) ?? null,
    lead_sequence_started: (rollup?.lead_sequence_started as number | null) ?? null,
    leads_completed: (rollup?.leads_completed as number | null) ?? null,
    leads_bounced: (rollup?.leads_bounced as number | null) ?? null,
    leads_unsubscribed: (rollup?.leads_unsubscribed as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Replace: instantly.getBatchCampaignAnalytics() for whole workspace
// Returns a Map of campaign-level lead data for all campaigns in a workspace.
// ---------------------------------------------------------------------------

export async function getWorkspaceLeadsBatch(
  sb: SupabaseClient,
  workspaceId: string,
  workspaceName?: string,
): Promise<Map<string, PipelineCampaignMeta>> {
  const wsIds = workspaceName && workspaceName !== workspaceId
    ? [workspaceId, workspaceName]
    : [workspaceId];

  const { data, error } = await sb
    .from('campaign_data')
    .select('campaign_id, total_leads, lead_sequence_started, leads_completed, leads_bounced, leads_unsubscribed, daily_limit, infra_type')
    .in('workspace_id', wsIds)
    .eq('step', '__ALL__')
    .eq('variant', '__ALL__');

  if (error) {
    console.error(`[pipeline-data] getWorkspaceLeadsBatch failed for ${workspaceId}: ${error.message}`);
    return new Map();
  }

  const result = new Map<string, PipelineCampaignMeta>();
  for (const row of data ?? []) {
    result.set(row.campaign_id as string, {
      daily_limit: (row.daily_limit as number | null) ?? null,
      infra_type: (row.infra_type as string | null) ?? null,
      contacted_count: (row.lead_sequence_started as number | null) ?? null,
      total_leads: (row.total_leads as number | null) ?? null,
      lead_sequence_started: (row.lead_sequence_started as number | null) ?? null,
      leads_completed: (row.leads_completed as number | null) ?? null,
      leads_bounced: (row.leads_bounced as number | null) ?? null,
      leads_unsubscribed: (row.leads_unsubscribed as number | null) ?? null,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Replace: resolveThreshold's provider detection
// Maps infra_type from campaign_data to kill threshold.
// ---------------------------------------------------------------------------

export function infraTypeToThreshold(infraType: string | null): number {
  if (infraType === 'google') return PROVIDER_THRESHOLDS[2]; // 3800
  if (infraType === 'outlook') return PROVIDER_THRESHOLDS[3]; // 5000
  return DEFAULT_THRESHOLD; // 4000
}

// ---------------------------------------------------------------------------
// Get step count and variant count per step.
// Replaces sequences[0].steps structure from Instantly API.
// ---------------------------------------------------------------------------

export async function getCampaignStructure(
  sb: SupabaseClient,
  campaignId: string,
): Promise<{
  stepCount: number;
  variantsByStep: Map<number, { count: number; variants: PipelineVariantRow[] }>;
}> {
  const variants = await getVariantAnalytics(sb, campaignId);

  // Group by step (already 0-indexed from getVariantAnalytics)
  const stepMap = new Map<number, PipelineVariantRow[]>();
  for (const v of variants) {
    if (!stepMap.has(v.step)) {
      stepMap.set(v.step, []);
    }
    stepMap.get(v.step)!.push(v);
  }

  // Sort variants within each step by variant index
  const variantsByStep = new Map<number, { count: number; variants: PipelineVariantRow[] }>();
  for (const [step, vars] of stepMap) {
    vars.sort((a, b) => a.variant - b.variant);
    variantsByStep.set(step, { count: vars.length, variants: vars });
  }

  return {
    stepCount: stepMap.size,
    variantsByStep,
  };
}
