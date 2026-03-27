import type { KillAction, LastVariantWarning, RescanEntry, LeadsCheckCandidate } from './types';
import { VARIANT_LABELS, OFF_CAMPAIGN_BUFFER, WINNER_THRESHOLD_MULTIPLIER, getStepMultiplier } from './config';

// ---------------------------------------------------------------------------
// Notification types & grouped titles
// ---------------------------------------------------------------------------

export type SlackNotificationType =
  | 'KILL'
  | 'LAST_VARIANT'
  | 'WARNING'
  | 'RESCAN_RE_ENABLED'
  | 'LEADS_EXHAUSTED'
  | 'LEADS_WARNING'
  | 'WINNER';

const GROUP_TITLES: Record<SlackNotificationType, (count: number) => string> = {
  KILL: (n) => `:rotating_light: Variants Automatically Disabled (${n})`,
  LAST_VARIANT: (n) => `:warning: Last Variant — Cannot Disable (${n})`,
  WARNING: (n) => `:eyes: Variants Approaching Threshold (${n})`,
  RESCAN_RE_ENABLED: (n) => `:white_check_mark: Variants Re-enabled (${n})`,
  LEADS_EXHAUSTED: (n) => `:red_circle: Leads Exhausted (${n} campaign${n === 1 ? '' : 's'})`,
  LEADS_WARNING: (n) => `:warning: Leads Running Low (${n} campaign${n === 1 ? '' : 's'})`,
  WINNER: (n) => `:trophy: Winning Variants Detected (${n})`,
};

export interface NotificationMeta {
  timestamp: string;
  notification_type: string;
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

export interface FlushResult {
  channelId: string;
  type: SlackNotificationType;
  title: string;
  threadTs: string | null;
  items: Array<{
    detail: string;
    replySuccess: boolean;
    meta: NotificationMeta;
  }>;
}

// ---------------------------------------------------------------------------
// Notification Collector — groups notifications by (channel, type)
// One parent message per type, individual details as thread replies
// ---------------------------------------------------------------------------

export class NotificationCollector {
  private buckets = new Map<string, Map<SlackNotificationType, Array<{ detail: string; meta: NotificationMeta }>>>();

  add(channelId: string, type: SlackNotificationType, detail: string, meta: NotificationMeta): void {
    if (!this.buckets.has(channelId)) {
      this.buckets.set(channelId, new Map());
    }
    const channelBuckets = this.buckets.get(channelId)!;
    if (!channelBuckets.has(type)) {
      channelBuckets.set(type, []);
    }
    channelBuckets.get(type)!.push({ detail, meta });
  }

  /** Total pending notifications across all channels and types */
  get size(): number {
    let total = 0;
    for (const types of this.buckets.values()) {
      for (const items of types.values()) {
        total += items.length;
      }
    }
    return total;
  }

  async flush(token: string, isDryRun: boolean, skipSlack = false): Promise<FlushResult[]> {
    const results: FlushResult[] = [];

    for (const [channelId, types] of this.buckets) {
      for (const [type, items] of types) {
        if (items.length === 0) continue;

        const title = GROUP_TITLES[type](items.length);

        if (isDryRun || skipSlack) {
          if (isDryRun) {
            console.log(`[DRY RUN] ${title} → channel=${channelId}`);
            for (const item of items) {
              console.log(`[DRY RUN]   └─ ${item.detail.split('\n')[0]}`);
            }
          }
          results.push({
            channelId, type, title, threadTs: null,
            items: items.map(i => ({ detail: i.detail, replySuccess: false, meta: i.meta })),
          });
          continue;
        }

        const threadTs = await postSlackMessage(channelId, title, token);
        const resultItems: FlushResult['items'] = [];

        if (threadTs) {
          for (const item of items) {
            await sleep(300);
            const replyTs = await postSlackMessage(channelId, item.detail, token, threadTs);
            resultItems.push({ detail: item.detail, replySuccess: replyTs !== null, meta: item.meta });
          }
        } else {
          for (const item of items) {
            resultItems.push({ detail: item.detail, replySuccess: false, meta: item.meta });
          }
        }

        results.push({ channelId, type, title, threadTs, items: resultItems });
      }
    }

    this.buckets.clear();
    return results;
  }
}

async function postSlackMessage(channel: string, text: string, token: string, threadTs?: string): Promise<string | null> {
  const payload: Record<string, string> = { channel, text, username: 'Campaign Control', icon_emoji: ':control_knobs:' };
  if (threadTs) payload.thread_ts = threadTs;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`Slack API error: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json() as { ok: boolean; ts?: string };
  return data.ok ? (data.ts ?? null) : null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function formatOffAnnotation(threshold: number): string {
  const base = Math.round(threshold / OFF_CAMPAIGN_BUFFER);
  return `\n\nℹ️ OFF campaign - threshold raised 20% (${base.toLocaleString()} -> ${threshold.toLocaleString()})`;
}

function formatStepAnnotation(stepIndex: number): string {
  if (stepIndex === 0) return '';
  const multiplier = getStepMultiplier(stepIndex);
  return `\n\nStep ${stepIndex + 1} follow-up - threshold ${multiplier}x (later steps get more runway)`;
}

export async function postThreadedMessage(
  channel: string,
  title: string,
  details: string,
  token: string,
): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const ts = await postSlackMessage(channel, title, token);
  if (ts) {
    await sleep(200);
    const replyTs = await postSlackMessage(channel, details, token, ts);
    return { threadTs: ts, replySuccess: replyTs !== null };
  }
  return { threadTs: null, replySuccess: false };
}

export function formatKillTitle(action: KillAction): string {
  const label = VARIANT_LABELS[action.variantIndex];
  return `:rotating_light: Auto Turn-Off: Variant ${label} disabled in Step ${action.stepIndex + 1}`;
}

export function formatKillDetails(action: KillAction): string {
  const {
    workspaceName,
    campaignName,
    stepIndex,
    variantIndex,
    sent,
    opportunities,
    ratio,
    threshold,
    notification,
    survivingVariantCount,
  } = action;

  const label = VARIANT_LABELS[variantIndex];
  const thresholdFormatted = threshold.toLocaleString();
  const ratioLine =
    opportunities === 0
      ? `0 opportunities past ${sent} sends`
      : `Ratio: ${sent}:${opportunities} = ${ratio} (threshold: ${thresholdFormatted}:1)`;

  let message = `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${label} → DISABLED

Emails sent: ${sent}
Opportunities: ${opportunities}
${ratioLine}`;

  if (notification === 'DOWN_TO_ONE') {
    message += `\n\n:warning: Step ${stepIndex + 1} now has only ${survivingVariantCount} active variant.\nAdd new variants to restore diversity and reduce deliverability risk.`;
  }

  if (action.isOff) {
    message += formatOffAnnotation(threshold);
  }

  message += formatStepAnnotation(stepIndex);

  return message;
}

export function formatLastVariantTitle(action: KillAction): string {
  const label = VARIANT_LABELS[action.variantIndex];
  return `:warning: Cannot disable Variant ${label} in Step ${action.stepIndex + 1} (last active)`;
}

export function formatLastVariantDetails(action: KillAction): string {
  const {
    workspaceName,
    campaignName,
    stepIndex,
    variantIndex,
    sent,
    opportunities,
    ratio,
    threshold,
  } = action;

  const label = VARIANT_LABELS[variantIndex];
  const thresholdFormatted = threshold.toLocaleString();
  const ratioLine =
    opportunities === 0
      ? `0 opportunities past ${sent} sends`
      : `Ratio: ${sent}:${opportunities} = ${ratio} (threshold: ${thresholdFormatted}:1)`;

  let message = `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${label}

This variant exceeded the kill threshold:
Emails sent: ${sent}
Opportunities: ${opportunities}
${ratioLine}

But it's the LAST active variant in Step ${stepIndex + 1}. The system did NOT disable it.

Action needed: Add 1+ new variants to this step, then manually turn off Variant ${label}.`;

  if (action.isOff) {
    message += formatOffAnnotation(threshold);
  }

  message += formatStepAnnotation(stepIndex);

  return message;
}

export function formatWarningTitle(
  warning: LastVariantWarning,
  stepIndex: number,
): string {
  return `:eyes: Early Warning: Variant ${warning.variantLabel} approaching threshold (${warning.pctConsumed}%)`;
}

export function formatWarningDetails(
  warning: LastVariantWarning,
  campaignName: string,
  workspaceName: string,
  stepIndex: number,
): string {
  let message = `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${warning.variantLabel}

Emails sent: ${warning.sent.toLocaleString()} / ${warning.threshold.toLocaleString()} (${warning.pctConsumed}% of auto-disable threshold)
Opportunities: ${warning.opportunities}

This variant will be auto-disabled when it hits ${warning.threshold.toLocaleString()} sends with insufficient opportunities.`;

  if (warning.isOff) {
    message += formatOffAnnotation(warning.threshold);
  }

  message += formatStepAnnotation(stepIndex);

  return message;
}

export function formatRescanTitle(entry: RescanEntry): string {
  return `:white_check_mark: Variant ${entry.variantLabel} re-enabled in Step ${entry.stepIndex + 1}`;
}

export function formatRescanDetails(
  entry: RescanEntry,
  currentOpportunities: number,
  currentRatio: string,
): string {
  const hoursAgo = Math.round(
    (Date.now() - new Date(entry.disabledAt).getTime()) / 3_600_000,
  );

  return `Workspace: ${entry.workspaceName}
Campaign: ${entry.campaignName}
Step ${entry.stepIndex + 1}, Variant ${entry.variantLabel} has been re-enabled.

This variant was disabled ${hoursAgo}h ago with ${entry.sent} sends and ${entry.opportunities} opportunities.
Late-arriving opportunities brought it to ${currentOpportunities} (ratio: ${currentRatio}:1, threshold: ${entry.threshold}:1).

No CM action needed.`;
}

export function formatLeadsWarningTitle(): string {
  return `:warning: Leads Running Low`;
}

export function formatLeadsWarningDetails(
  candidate: LeadsCheckCandidate,
  uncontacted: number,
  totalLeads: number,
): string {
  return `Workspace: ${candidate.workspaceName}
Campaign: ${candidate.campaignName}

${uncontacted.toLocaleString()} / ${totalLeads.toLocaleString()} leads uncontacted. Daily limit: ${candidate.dailyLimit.toLocaleString()}.`;
}

export function formatLeadsExhaustedTitle(): string {
  return `:red_circle: Leads Exhausted`;
}

export function formatLeadsExhaustedDetails(
  candidate: LeadsCheckCandidate,
  totalLeads: number,
  activeLeads: number,
): string {
  let message = `Workspace: ${candidate.workspaceName}
Campaign: ${candidate.campaignName}

0 / ${totalLeads.toLocaleString()} leads uncontacted.`;

  if (activeLeads > 0) {
    message += `\n\n${activeLeads.toLocaleString()} leads still active in sequence. If no new leads are needed, no action required.`;
  }

  return message;
}

export function formatWinnerDetails(
  workspaceName: string,
  campaignName: string,
  stepIndex: number,
  variantLabel: string,
  sent: number,
  opportunities: number,
  ratio: number,
  killThreshold: number,
  isOff: boolean,
  leadsNote: string | null,
): string {
  const improvement = Math.round(killThreshold / ratio);
  let message = `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${variantLabel} - WINNING

Emails sent: ${sent.toLocaleString()}
Opportunities: ${opportunities}
Ratio: ${ratio.toFixed(0)}:1 (threshold: ${killThreshold.toLocaleString()}:1 - ${improvement}x better)`;

  if (isOff) {
    message += formatOffAnnotation(killThreshold);
  }

  message += formatStepAnnotation(stepIndex);

  if (leadsNote) {
    message += `\n\n${leadsNote}`;
  }

  return message;
}

export function formatAllVariantsWinning(stepIndex: number): string {
  return `All variants in Step ${stepIndex + 1} are performing well. Add more leads to this campaign.`;
}

export function formatCampaignWinnerRollup(campaignName: string, steps: number[]): string {
  const stepList = steps.map(s => s + 1).join(' and ');
  return `Campaign ${campaignName} has winning variants in Steps ${stepList}. Strong candidate for increased volume.`;
}

// ---------------------------------------------------------------------------
// Morning digest
// ---------------------------------------------------------------------------

export async function sendMorningDigest(
  channel: string,
  cm: string,
  dashboardUrl: string,
  summary: { activeCount: number; criticalCount: number; killsSince: number; reEnablesSince: number; winnersLast24h: Array<{ campaignName: string; variantLabel: string; ratio: string }> },
  token: string,
  isDryRun: boolean,
): Promise<void> {
  const statusLine = summary.criticalCount > 0
    ? `Status: ${summary.criticalCount} campaign${summary.criticalCount === 1 ? '' : 's'} need${summary.criticalCount === 1 ? 's' : ''} attention`
    : 'Status: No critical alerts';

  let winnersLine = '';
  if (summary.winnersLast24h.length > 0) {
    const topPerformers = summary.winnersLast24h
      .slice(0, 5)
      .map(w => `[${w.campaignName}] Variant ${w.variantLabel} (${w.ratio})`)
      .join(', ');
    winnersLine = `\nTop performers (last 24h): ${topPerformers}`;
  }

  const text = `*Campaign Control - Daily Summary*

Action items: ${summary.activeCount}
Since yesterday: ${summary.killsSince} variant${summary.killsSince === 1 ? '' : 's'} turned off, ${summary.reEnablesSince} re-enabled
${statusLine}${winnersLine}

<${dashboardUrl}|View Dashboard>`;

  if (isDryRun) {
    console.log(`[DRY RUN] Morning digest -> ${cm} (${channel}):\n${text}`);
    return;
  }

  await postSlackMessage(channel, text, token);
}
