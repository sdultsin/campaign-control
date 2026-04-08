import { McpClient } from './mcp-client';
import { InstantlyApi } from './instantly';
import { InstantlyDirectApi } from './instantly-direct';
import { getSupabaseClient } from './supabase';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Revert handler: re-enables variants killed during a specific date's run
// Usage: GET /__revert?dry_run=true&date=2026-03-18
// ---------------------------------------------------------------------------

interface RevertTarget {
  campaignId: string;
  campaign: string;
  workspaceId: string;
  workspace: string;
  step: number;
  variant: number;
  variantLabel: string;
  cm: string | null;
  product: string;
}

interface VariantResult {
  step: number;
  variantLabel: string;
  status: 'reverted' | 'already_enabled' | 'not_found' | 'verify_failed';
}

interface CampaignResult {
  campaignId: string;
  campaign: string;
  workspace: string;
  cm: string | null;
  variants: VariantResult[];
  error?: string;
}

export async function handleRevert(env: Env, params: URLSearchParams): Promise<Response> {
  const dryRun = params.get('dry_run') !== 'false';
  const targetDate = params.get('date') ?? '2026-03-18';

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return Response.json({ error: 'Supabase not configured' }, { status: 500 });
  }
  const sb = getSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

  // 1. Query all DISABLED (real) entries for the target date
  const { data: disabledRaw, error: disabledErr } = await sb
    .from('cc_audit_logs')
    .select('campaign_id, campaign, workspace_id, workspace, step, variant, variant_label, cm, product')
    .eq('action', 'DISABLED')
    .eq('dry_run', false)
    .gte('timestamp', `${targetDate}T00:00:00Z`)
    .lte('timestamp', `${targetDate}T23:59:59Z`);

  if (disabledErr) {
    return Response.json({ error: `Disabled query failed: ${disabledErr.message}` }, { status: 500 });
  }

  // 2. Query already-reverted entries (RE_ENABLED, CM_OVERRIDE, or previous MANUAL_REVERT)
  const { data: revertedRaw, error: revertedErr } = await sb
    .from('cc_audit_logs')
    .select('campaign_id, step, variant')
    .in('action', ['RE_ENABLED', 'CM_OVERRIDE', 'MANUAL_REVERT'])
    .eq('dry_run', false)
    .gte('timestamp', `${targetDate}T00:00:00Z`);

  if (revertedErr) {
    return Response.json({ error: `Reverted query failed: ${revertedErr.message}` }, { status: 500 });
  }

  // 3. Deduplicate: unique (campaign_id, step, variant) not already reverted
  const revertedKeys = new Set(
    (revertedRaw ?? []).map((r: Record<string, unknown>) =>
      `${r.campaign_id}:${r.step}:${r.variant}`,
    ),
  );
  const seenKeys = new Set<string>();
  const targets: RevertTarget[] = [];

  for (const row of (disabledRaw ?? []) as Record<string, unknown>[]) {
    const key = `${row.campaign_id}:${row.step}:${row.variant}`;
    if (revertedKeys.has(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    targets.push({
      campaignId: row.campaign_id as string,
      campaign: row.campaign as string,
      workspaceId: row.workspace_id as string,
      workspace: row.workspace as string,
      step: row.step as number,
      variant: row.variant as number,
      variantLabel: row.variant_label as string,
      cm: row.cm as string | null,
      product: row.product as string,
    });
  }

  // Group by campaign
  const byCampaign = new Map<string, RevertTarget[]>();
  for (const t of targets) {
    const list = byCampaign.get(t.campaignId) ?? [];
    list.push(t);
    byCampaign.set(t.campaignId, list);
  }

  if (targets.length === 0) {
    return Response.json({
      message: 'Nothing to revert — all targets already re-enabled',
      dryRun,
      date: targetDate,
    });
  }

  // ---------------------------------------------------------------------------
  // DRY RUN: report what would happen
  // ---------------------------------------------------------------------------
  if (dryRun) {
    const campaigns = [...byCampaign.entries()].map(([id, tgts]) => ({
      campaignId: id,
      campaign: tgts[0].campaign,
      workspace: tgts[0].workspace,
      cm: tgts[0].cm,
      variantStepCount: tgts.length,
      variantSteps: tgts.map((t) => `Step ${t.step} → ${t.variantLabel}`),
    }));

    return Response.json({
      mode: 'DRY_RUN',
      date: targetDate,
      message: 'No changes made. Pass ?dry_run=false to execute.',
      totalVariantSteps: targets.length,
      uniqueCampaigns: byCampaign.size,
      campaigns,
    });
  }

  // ---------------------------------------------------------------------------
  // LIVE RUN: use direct API or MCP to batch-revert
  // ---------------------------------------------------------------------------
  const useDirectApi = env.INSTANTLY_MODE === 'direct' && env.INSTANTLY_API_KEYS;
  const mcp = useDirectApi ? null : new McpClient();
  const mcpApi = mcp ? new InstantlyApi(mcp) : null;
  const directApi = useDirectApi ? new InstantlyDirectApi(env.INSTANTLY_API_KEYS) : null;
  const results: CampaignResult[] = [];

  try {
    if (mcp) await mcp.connect();

    for (const [campaignId, campaignTargets] of byCampaign) {
      const first = campaignTargets[0];
      const result: CampaignResult = {
        campaignId,
        campaign: first.campaign,
        workspace: first.workspace,
        cm: first.cm,
        variants: [],
      };

      try {
        // Fetch current campaign details
        const detail = directApi
          ? await directApi.getCampaignDetails(first.workspaceId, campaignId)
          : await mcpApi!.getCampaignDetails(first.workspaceId, campaignId);
        const cloned = structuredClone(detail.sequences);
        let needsUpdate = false;

        for (const t of campaignTargets) {
          const v = cloned?.[0]?.steps?.[t.step]?.variants?.[t.variant];
          if (!v) {
            result.variants.push({ step: t.step, variantLabel: t.variantLabel, status: 'not_found' });
            continue;
          }
          if (v.v_disabled !== true) {
            result.variants.push({ step: t.step, variantLabel: t.variantLabel, status: 'already_enabled' });
            continue;
          }
          v.v_disabled = false;
          needsUpdate = true;
          result.variants.push({ step: t.step, variantLabel: t.variantLabel, status: 'reverted' });
        }

        if (needsUpdate) {
          // Single update call per campaign (batch all variant-steps)
          if (directApi) {
            await directApi.updateCampaign(first.workspaceId, campaignId, { sequences: cloned });
          } else {
            await mcp!.callTool('update_campaign', {
              workspace_id: first.workspaceId,
              campaign_id: campaignId,
              updates: { sequences: cloned },
            });
          }

          // Verify with a single getCampaignDetails call
          const verified = directApi
            ? await directApi.getCampaignDetails(first.workspaceId, campaignId)
            : await mcpApi!.getCampaignDetails(first.workspaceId, campaignId);
          for (const vr of result.variants) {
            if (vr.status !== 'reverted') continue;
            const t = campaignTargets.find(
              (ct) => ct.step === vr.step && ct.variantLabel === vr.variantLabel,
            )!;
            const check = verified.sequences?.[0]?.steps?.[t.step]?.variants?.[t.variant];
            if (check?.v_disabled === true) {
              vr.status = 'verify_failed';
            }
          }

          // Log each successfully reverted variant to Supabase
          for (const vr of result.variants) {
            if (vr.status !== 'reverted') continue;
            const t = campaignTargets.find(
              (ct) => ct.step === vr.step && ct.variantLabel === vr.variantLabel,
            )!;
            await sb.from('cc_audit_logs').insert({
              timestamp: new Date().toISOString(),
              action: 'MANUAL_REVERT',
              workspace: t.workspace,
              workspace_id: t.workspaceId,
              campaign: t.campaign,
              campaign_id: t.campaignId,
              step: t.step,
              variant: t.variant,
              variant_label: t.variantLabel,
              cm: t.cm,
              product: t.product,
              trigger_sent: 0,
              trigger_opportunities: 0,
              trigger_ratio: '0',
              trigger_threshold: 0,
              trigger_rule: `Bulk revert of ${targetDate} pilot kills`,
              safety_surviving_variants: -1,
              safety_notification: null,
              dry_run: false,
            });
          }
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }

      results.push(result);
    }
  } finally {
    if (mcp) {
      try {
        await mcp.close();
      } catch { /* ignore */ }
    }
  }

  const totalReverted = results.reduce(
    (sum, r) => sum + r.variants.filter((v) => v.status === 'reverted').length, 0,
  );
  const totalAlreadyEnabled = results.reduce(
    (sum, r) => sum + r.variants.filter((v) => v.status === 'already_enabled').length, 0,
  );
  const totalVerifyFailed = results.reduce(
    (sum, r) => sum + r.variants.filter((v) => v.status === 'verify_failed').length, 0,
  );
  const totalNotFound = results.reduce(
    (sum, r) => sum + r.variants.filter((v) => v.status === 'not_found').length, 0,
  );
  const campaignErrors = results.filter((r) => r.error).length;

  return Response.json({
    mode: 'LIVE',
    date: targetDate,
    summary: {
      reverted: totalReverted,
      alreadyEnabled: totalAlreadyEnabled,
      verifyFailed: totalVerifyFailed,
      notFound: totalNotFound,
      campaignErrors,
    },
    campaigns: results,
  });
}
