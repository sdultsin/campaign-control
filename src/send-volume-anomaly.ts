import type { SupabaseClient } from '@supabase/supabase-js';
import type { InstantlyDirectApi } from './instantly-direct';
import { upsertDashboardItem, writeNotificationToSupabase } from './supabase';
import {
  PAIR_VOLUME,
  RG_TO_PAIR,
  SEND_VOLUME_WORKSPACE_SLUG,
  SEND_VOLUME_UNDER_RATIO,
  SEND_VOLUME_OVER_RATIO,
  SEND_VOLUME_DEDUP_TTL_SECONDS,
  SEND_VOLUME_PILOT_CMS,
  SEND_VOLUME_SAM_NAME_SUBSTR,
  SEND_VOLUME_CHECK_ENABLED,
} from './config';

/**
 * Send-volume anomaly check (Sam pilot). Surface to the CM Supervision Console
 * via cc_dashboard_items when a campaign's today_sent is materially above or
 * below its expected daily volume (derived from RG batch tags -> pair -> pair
 * volume). See spec: specs/2026-04-16-cc-send-volume-anomaly-alert.md.
 *
 * Dashboard-only: does NOT fire Slack. Relies on the fact that dashboard items
 * are the surface the CM Supervision Console renders; per-item Slack is
 * globally suppressed by SLACK_SUPPRESSED.
 */

// --- Types ---------------------------------------------------------------

export type AnomalyDirection = 'under' | 'over';

export interface SendVolumeCandidate {
  campaignId: string;
  campaignName: string;
  workspaceName: string; // campaign_data.workspace_name (display name, e.g. "Renaissance 3")
  rgBatchTags: string[];
  status: string;
}

export interface ResolvedCandidate extends SendVolumeCandidate {
  workspaceSlug: string;
  pairs: string[];
  expected: number;
}

export interface AnomalyDecision {
  fire: boolean;
  direction: AnomalyDirection | null;
  ratio: number;
  reason: string;
}

export interface SendVolumeRunSummary {
  ranAt: string;
  campaignsChecked: number;
  alertsFiredUnder: number;
  alertsFiredOver: number;
  dedupSkipped: number;
  weekendSkipped: number;
  unresolvedPairs: number;
  unmappedWorkspace: number;
  apiErrors: number;
  analyticsDate: string;
}

// --- Pure helpers (heavy Vitest coverage lives here) --------------------

/**
 * Resolve a list of unique pair identifiers from a campaign's RG batch tags.
 * Unknown RGs are silently dropped; caller can detect "no pairs" via the
 * returned array being empty.
 */
export function resolvePairs(rgBatchTags: string[] | null | undefined): string[] {
  if (!rgBatchTags || rgBatchTags.length === 0) return [];
  const seen = new Set<string>();
  for (const tag of rgBatchTags) {
    const pair = RG_TO_PAIR[tag];
    if (pair) seen.add(pair);
  }
  return Array.from(seen);
}

/**
 * Sum pair volumes. Unknown pairs contribute 0 (shouldn't happen in practice
 * because resolvePairs only returns pairs that exist in RG_TO_PAIR, and we
 * keep the two maps in sync).
 */
export function sumExpectedVolume(pairs: string[]): number {
  let total = 0;
  for (const pair of pairs) {
    total += PAIR_VOLUME[pair] ?? 0;
  }
  return total;
}

/**
 * Decide whether an alert should fire given today's sent vs expected.
 * Applies the weekend-silence rule (today_sent === 0 AND UTC day is Sat/Sun
 * -> skip) before the threshold bands.
 *
 * @param todaySent   Today's cumulative sent total for the campaign.
 * @param expected    Sum of pair volumes.
 * @param utcDay      0=Sunday ... 6=Saturday, per Date.getUTCDay().
 */
export function evaluateAnomaly(
  todaySent: number,
  expected: number,
  utcDay: number,
): AnomalyDecision {
  if (expected <= 0) {
    return { fire: false, direction: null, ratio: 0, reason: 'expected_zero' };
  }
  if (todaySent === 0 && (utcDay === 0 || utcDay === 6)) {
    return { fire: false, direction: null, ratio: 0, reason: 'weekend_silence' };
  }
  const ratio = todaySent / expected;
  if (ratio < SEND_VOLUME_UNDER_RATIO) {
    return { fire: true, direction: 'under', ratio, reason: 'under_threshold' };
  }
  if (ratio > SEND_VOLUME_OVER_RATIO) {
    return { fire: true, direction: 'over', ratio, reason: 'over_threshold' };
  }
  return { fire: false, direction: null, ratio, reason: 'in_band' };
}

/** Format today's UTC date as YYYY-MM-DD. */
export function todayUtcIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** KV dedup key. One per (day, campaign, direction). */
export function dedupKey(dateIso: string, campaignId: string, direction: AnomalyDirection): string {
  return `anomaly_fired:${dateIso}:${campaignId}:${direction}`;
}

// --- Supabase query ------------------------------------------------------

/**
 * Fetch active Sam campaigns from Pipeline Supabase. Mirrors the spec §5.1
 * query. Filters: status='1', name ILIKE '%(SAM)%', step='__ALL__',
 * variant='__ALL__' (so we get one row per campaign, not one per variant).
 *
 * rg_batch_tags is a text[] column on campaign_data; returned as a JS array.
 */
export async function fetchActiveSamCampaigns(
  sb: SupabaseClient,
): Promise<SendVolumeCandidate[]> {
  const { data, error } = await sb
    .from('campaign_data')
    .select('campaign_id, campaign_name, workspace_name, rg_batch_tags, status')
    .eq('step', '__ALL__')
    .eq('variant', '__ALL__')
    .eq('status', '1')
    .ilike('campaign_name', `%${SEND_VOLUME_SAM_NAME_SUBSTR}%`);

  if (error) {
    console.error(`[send-volume] fetchActiveSamCampaigns failed: ${error.message}`);
    return [];
  }

  // Dedup by campaign_id defensively (shouldn't happen -- (campaign_id, '__ALL__', '__ALL__')
  // is the upsert conflict target in the pipeline, so there's exactly one row).
  const seen = new Set<string>();
  const out: SendVolumeCandidate[] = [];
  for (const row of data ?? []) {
    const id = row.campaign_id as string;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      campaignId: id,
      campaignName: (row.campaign_name as string) ?? '',
      workspaceName: (row.workspace_name as string) ?? '',
      rgBatchTags: (row.rg_batch_tags as string[] | null) ?? [],
      status: (row.status as string) ?? '',
    });
  }
  return out;
}

// --- Main check loop -----------------------------------------------------

export async function runSendVolumeCheck(params: {
  sb: SupabaseClient;
  instantly: InstantlyDirectApi;
  kv: KVNamespace;
  now?: Date;
  isDryRun?: boolean;
}): Promise<SendVolumeRunSummary> {
  const now = params.now ?? new Date();
  const analyticsDate = todayUtcIso(now);
  const utcDay = now.getUTCDay();

  const summary: SendVolumeRunSummary = {
    ranAt: now.toISOString(),
    campaignsChecked: 0,
    alertsFiredUnder: 0,
    alertsFiredOver: 0,
    dedupSkipped: 0,
    weekendSkipped: 0,
    unresolvedPairs: 0,
    unmappedWorkspace: 0,
    apiErrors: 0,
    analyticsDate,
  };

  if (!SEND_VOLUME_CHECK_ENABLED) {
    console.log('[send-volume] disabled via SEND_VOLUME_CHECK_ENABLED=false, skipping');
    return summary;
  }

  const candidates = await fetchActiveSamCampaigns(params.sb);
  console.log(`[send-volume] found ${candidates.length} active Sam campaigns`);

  for (const cand of candidates) {
    // Pilot CM gate. Redundant with the (SAM) name filter but makes the code
    // safe to generalize: adding another CM to SEND_VOLUME_PILOT_CMS + a name
    // filter would be the only change.
    if (!SEND_VOLUME_PILOT_CMS.has('SAM')) {
      continue; // defensive; spec is Sam-only
    }

    const workspaceSlug = SEND_VOLUME_WORKSPACE_SLUG[cand.workspaceName];
    if (!workspaceSlug) {
      console.warn(
        `[send-volume] unmapped workspace_name="${cand.workspaceName}" for campaign ${cand.campaignId} (${cand.campaignName}); skipping`,
      );
      summary.unmappedWorkspace++;
      continue;
    }

    const pairs = resolvePairs(cand.rgBatchTags);
    if (pairs.length === 0) {
      console.warn(
        `[send-volume] no pairs resolved for campaign ${cand.campaignId} (${cand.campaignName}); tags=${JSON.stringify(cand.rgBatchTags)}; skipping`,
      );
      summary.unresolvedPairs++;
      continue;
    }
    const expected = sumExpectedVolume(pairs);
    if (expected <= 0) {
      console.warn(
        `[send-volume] expected=0 for campaign ${cand.campaignId} (pairs=${pairs.join(',')}); skipping`,
      );
      summary.unresolvedPairs++;
      continue;
    }

    // Call Instantly daily analytics. Isolate API errors per campaign.
    let todaySent = 0;
    try {
      const rows = await params.instantly.getDailyAnalytics(
        workspaceSlug,
        cand.campaignId,
        analyticsDate,
        analyticsDate,
      );
      // Spec §9: treat missing/null sent as 0.
      const row = rows[0];
      todaySent = typeof row?.sent === 'number' ? row.sent : 0;
    } catch (err) {
      console.error(
        `[send-volume] analytics call failed for campaign ${cand.campaignId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      summary.apiErrors++;
      continue;
    }

    summary.campaignsChecked++;

    const decision = evaluateAnomaly(todaySent, expected, utcDay);
    console.log(
      `[send-volume] campaign=${cand.campaignId} name="${cand.campaignName}" expected=${expected} sent=${todaySent} ratio=${decision.ratio.toFixed(3)} decision=${decision.reason}`,
    );

    if (decision.reason === 'weekend_silence') {
      summary.weekendSkipped++;
      continue;
    }
    if (!decision.fire || !decision.direction) continue;

    // KV dedup: once per (day, campaign, direction).
    const kvKey = dedupKey(analyticsDate, cand.campaignId, decision.direction);
    const existing = await params.kv.get(kvKey);
    if (existing) {
      summary.dedupSkipped++;
      console.log(`[send-volume] dedup skip campaign=${cand.campaignId} direction=${decision.direction}`);
      continue;
    }

    // Severity per spec §8: under = warning, over = info.
    const severity = decision.direction === 'under' ? 'WARNING' : 'INFO';

    const context = {
      category: 'send_volume_anomaly',
      direction: decision.direction,
      expected_volume: expected,
      actual_volume: todaySent,
      ratio: Number(decision.ratio.toFixed(4)),
      pairs,
      rg_batch_tags: cand.rgBatchTags,
      workspace_slug: workspaceSlug,
      analytics_date: analyticsDate,
      dedup_key: kvKey,
    };

    try {
      // Dashboard surface: cc_dashboard_items. CM='Sam' (dashboard canonicalizes
      // to capitalized form in the existing routing gate via CM_CHANNEL_MAP --
      // 'SAM' is the registered key, which the supervision console URL lowercases).
      await upsertDashboardItem(params.sb, {
        item_type: 'SEND_VOLUME_ANOMALY',
        severity,
        cm: 'SAM',
        campaign_id: cand.campaignId,
        campaign_name: cand.campaignName,
        workspace_id: workspaceSlug,
        workspace_name: cand.workspaceName,
        step: null,
        variant: null,
        variant_label: null,
        context,
      });

      // Audit trail: cc_notifications. channel_id is blank because we don't
      // send Slack for this type; the row is kept for observability parity
      // with other notification types.
      await writeNotificationToSupabase(params.sb, {
        timestamp: new Date().toISOString(),
        notification_type: 'SEND_VOLUME_ANOMALY',
        channel_id: '',
        title: `Send-Volume Anomaly (${decision.direction.toUpperCase()})`,
        details: JSON.stringify(context),
        thread_ts: null,
        reply_success: null,
        campaign_id: cand.campaignId,
        campaign_name: cand.campaignName,
        workspace_id: workspaceSlug,
        workspace_name: cand.workspaceName,
        cm: 'SAM',
        step: null,
        variant: null,
        variant_label: null,
        dry_run: params.isDryRun ?? false,
      });
    } catch (err) {
      console.error(
        `[send-volume] dashboard/notification write failed for campaign ${cand.campaignId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall through: still set KV dedup so we don't spam on retries.
    }

    // Set dedup KV last. Even if the Supabase write above failed, we still
    // stamp KV so the next retry in the same UTC day doesn't hammer the API.
    // In dry-run mode we skip the dedup write so local testing stays idempotent.
    if (!(params.isDryRun ?? false)) {
      await params.kv
        .put(kvKey, new Date().toISOString(), { expirationTtl: SEND_VOLUME_DEDUP_TTL_SECONDS })
        .catch((err) => console.error(`[send-volume] KV dedup put failed: ${err}`));
    }

    if (decision.direction === 'under') summary.alertsFiredUnder++;
    else summary.alertsFiredOver++;
  }

  console.log(
    `[send-volume] done: ${JSON.stringify(summary)}`,
  );
  return summary;
}
