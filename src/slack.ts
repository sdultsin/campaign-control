import type { KillAction, Env, LastVariantWarning, RescanEntry, LeadsCheckCandidate } from './types';
import { VARIANT_LABELS } from './config';

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

export async function postThreadedMessage(
  channel: string,
  title: string,
  details: string,
  token: string,
): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const ts = await postSlackMessage(channel, title, token);
  if (ts) {
    await sleep(500);
    const replyTs = await postSlackMessage(channel, details, token, ts);
    await sleep(1000);
    return { threadTs: ts, replySuccess: replyTs !== null };
  }
  await sleep(1000);
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

  return `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${label}

This variant exceeded the kill threshold:
Emails sent: ${sent}
Opportunities: ${opportunities}
${ratioLine}

But it's the LAST active variant in Step ${stepIndex + 1}. The system did NOT disable it.

Action needed: Add 1+ new variants to this step, then manually turn off Variant ${label}.`;
}

export async function sendKillNotification(action: KillAction, channelId: string, env: Env): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const title = formatKillTitle(action);
  const details = formatKillDetails(action);
  if (env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] ${title}\n${details}`);
    return { threadTs: null, replySuccess: false };
  }
  return postThreadedMessage(channelId, title, details, env.SLACK_BOT_TOKEN);
}

export async function sendLastVariantNotification(action: KillAction, channelId: string, env: Env): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const title = formatLastVariantTitle(action);
  const details = formatLastVariantDetails(action);
  if (env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] ${title}\n${details}`);
    return { threadTs: null, replySuccess: false };
  }
  return postThreadedMessage(channelId, title, details, env.SLACK_BOT_TOKEN);
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
  return `Workspace: ${workspaceName}
Campaign: ${campaignName}
Step ${stepIndex + 1}, Variant ${warning.variantLabel}

Emails sent: ${warning.sent.toLocaleString()} / ${warning.threshold.toLocaleString()} (${warning.pctConsumed}% of auto-disable threshold)
Opportunities: ${warning.opportunities}

This variant will be auto-disabled when it hits ${warning.threshold.toLocaleString()} sends with insufficient opportunities.`;
}

export async function sendWarningNotification(
  warning: LastVariantWarning,
  campaignName: string,
  workspaceName: string,
  stepIndex: number,
  channelId: string,
  env: Env,
): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const title = formatWarningTitle(warning, stepIndex);
  const details = formatWarningDetails(warning, campaignName, workspaceName, stepIndex);
  if (env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] ${title}\n${details}`);
    return { threadTs: null, replySuccess: false };
  }
  return postThreadedMessage(channelId, title, details, env.SLACK_BOT_TOKEN);
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

export async function sendRescanNotification(
  entry: RescanEntry,
  currentOpportunities: number,
  currentRatio: string,
  channelId: string,
  env: Env,
): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const title = formatRescanTitle(entry);
  const details = formatRescanDetails(entry, currentOpportunities, currentRatio);
  if (env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] ${title}\n${details}`);
    return { threadTs: null, replySuccess: false };
  }
  return postThreadedMessage(channelId, title, details, env.SLACK_BOT_TOKEN);
}

export function formatLeadsWarningTitle(): string {
  return `:warning: Leads Running Low`;
}

export function formatLeadsWarningDetails(
  candidate: LeadsCheckCandidate,
  uncontacted: number,
  totalLeads: number,
): string {
  return `Campaign: ${candidate.campaignName}
Workspace: ${candidate.workspaceName}

${uncontacted.toLocaleString()} / ${totalLeads.toLocaleString()} leads remaining. Daily limit: ${candidate.dailyLimit.toLocaleString()}.`;
}

export async function sendLeadsWarningNotification(
  candidate: LeadsCheckCandidate,
  uncontacted: number,
  totalLeads: number,
  channelId: string,
  env: Env,
): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const title = formatLeadsWarningTitle();
  const details = formatLeadsWarningDetails(candidate, uncontacted, totalLeads);
  if (env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] ${title}\n${details}`);
    return { threadTs: null, replySuccess: false };
  }
  return postThreadedMessage(channelId, title, details, env.SLACK_BOT_TOKEN);
}

export function formatLeadsExhaustedTitle(): string {
  return `:red_circle: Leads Exhausted`;
}

export function formatLeadsExhaustedDetails(
  candidate: LeadsCheckCandidate,
  totalLeads: number,
): string {
  return `Campaign: ${candidate.campaignName}
Workspace: ${candidate.workspaceName}

0 / ${totalLeads.toLocaleString()} leads remaining.`;
}

export async function sendLeadsExhaustedNotification(
  candidate: LeadsCheckCandidate,
  totalLeads: number,
  channelId: string,
  env: Env,
): Promise<{ threadTs: string | null; replySuccess: boolean }> {
  const title = formatLeadsExhaustedTitle();
  const details = formatLeadsExhaustedDetails(candidate, totalLeads);
  if (env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] ${title}\n${details}`);
    return { threadTs: null, replySuccess: false };
  }
  return postThreadedMessage(channelId, title, details, env.SLACK_BOT_TOKEN);
}
