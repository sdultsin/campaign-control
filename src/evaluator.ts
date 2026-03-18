import type { StepAnalytics, Step, Decision, SafetyResult, NotificationType, LastVariantWarning } from './types';
import { LAST_VARIANT_WARNING_PCT, VARIANT_LABELS } from './config';

// Evaluate a single variant against the threshold.
// threshold doubles as both the minimum-sends gate and the sent/opportunities ratio ceiling.
export function evaluateVariant(sent: number, opportunities: number, threshold: number): Decision {
  if (sent < threshold) {
    return { action: 'SKIP', reason: 'Below minimum sends gate' };
  }
  if (opportunities === 0) {
    return { action: 'KILL_CANDIDATE', reason: `${sent} sent, 0 opportunities` };
  }
  const ratio = sent / opportunities;
  if (ratio > threshold) {
    return {
      action: 'KILL_CANDIDATE',
      reason: `Ratio ${ratio.toFixed(1)}:1 exceeds threshold`,
    };
  }
  return { action: 'KEEP', reason: `Ratio ${ratio.toFixed(1)}:1 within threshold` };
}

// Safety check — can we kill the target indices without emptying the step?
export function safetyCheck(step: Step, killTargetIndices: number[]): SafetyResult {
  const killSet = new Set(killTargetIndices);
  const remaining = step.variants.filter(
    (v, i) => v.v_disabled !== true && !killSet.has(i),
  ).length;

  if (remaining === 0) {
    return { canKill: false, notify: 'LAST_VARIANT', remainingActive: 0 };
  }
  if (remaining === 1) {
    return { canKill: true, notify: 'DOWN_TO_ONE', remainingActive: 1 };
  }
  return { canKill: true, notify: null, remainingActive: remaining };
}

// Evaluate all analytics for one campaign step; return confirmed kill indices + worst notification.
export function evaluateStep(
  analytics: StepAnalytics[],
  step: Step,
  stepIndex: number,
  threshold: number,
): { kills: Array<{ variantIndex: number; notification: NotificationType }>; blocked: { variantIndex: number; notification: NotificationType } | null } {
  // Only consider analytics rows for this step whose corresponding variant is not already disabled.
  const activeAnalytics = analytics.filter((a) => {
    if (parseInt(a.step, 10) !== stepIndex) return false;
    const variantIdx = parseInt(a.variant, 10);
    const variant = step.variants[variantIdx];
    if (variant === undefined) {
      console.warn(
        `[auto-turnoff] Analytics references non-existent variant ${variantIdx} in step ${stepIndex} (step has ${step.variants.length} variants)`,
      );
      return false;
    }
    return variant.v_disabled !== true;
  });

  // Collect KILL_CANDIDATE indices (using the variant field as the index into step.variants).
  const candidates: Array<{ variantIndex: number; sortKey: number }> = [];
  for (const row of activeAnalytics) {
    const decision = evaluateVariant(row.sent, row.opportunities, threshold);
    if (decision.action === 'KILL_CANDIDATE') {
      // Worst performers first: 0 opportunities = Infinity ratio.
      const sortKey = row.opportunities === 0 ? Infinity : row.sent / row.opportunities;
      candidates.push({ variantIndex: parseInt(row.variant, 10), sortKey });
    }
  }

  // Sort worst -> best (highest ratio first).
  candidates.sort((a, b) => b.sortKey - a.sortKey);

  // Iteratively confirm kills, stopping as soon as safety would be violated.
  // Each kill gets its OWN notification type (not a merged "worst" across the step).
  const confirmedKills: Array<{ variantIndex: number; notification: NotificationType }> = [];
  let blocked: { variantIndex: number; notification: NotificationType } | null = null;

  for (const candidate of candidates) {
    const prospective = [...confirmedKills.map((k) => k.variantIndex), candidate.variantIndex];
    const safety = safetyCheck(step, prospective);

    if (!safety.canKill) {
      // Killing this one would leave the step empty — don't kill, but record for notification.
      blocked = { variantIndex: candidate.variantIndex, notification: safety.notify };
      break;
    }

    confirmedKills.push({ variantIndex: candidate.variantIndex, notification: safety.notify });
  }

  return { kills: confirmedKills, blocked };
}

// Return the more severe of two NotificationType values.
// Severity order: LAST_VARIANT > DOWN_TO_ONE > null
function mergeNotification(a: NotificationType, b: NotificationType): NotificationType {
  if (a === 'LAST_VARIANT' || b === 'LAST_VARIANT') return 'LAST_VARIANT';
  if (a === 'DOWN_TO_ONE' || b === 'DOWN_TO_ONE') return 'DOWN_TO_ONE';
  return null;
}

/**
 * Check ALL active variants in a step that are approaching the kill threshold.
 * Returns a warning for every active variant that has consumed >= 80% of threshold sends
 * but hasn't crossed it yet (those that crossed are handled by evaluateStep as kills).
 * Called AFTER evaluateStep — only for variants not already killed or blocked.
 */
export function checkVariantWarnings(
  step: Step,
  analytics: StepAnalytics[],
  stepIndex: number,
  threshold: number,
  killedIndices: number[],
): LastVariantWarning[] {
  const killedSet = new Set(killedIndices);
  const warnings: LastVariantWarning[] = [];

  for (let i = 0; i < step.variants.length; i++) {
    // Skip disabled, already-killed, or blocked variants
    if (step.variants[i].v_disabled === true) continue;
    if (killedSet.has(i)) continue;

    const variantAnalytics = analytics.find(
      (a) => parseInt(a.step, 10) === stepIndex && parseInt(a.variant, 10) === i,
    );
    if (!variantAnalytics) continue;

    const sent = variantAnalytics.sent;
    const opportunities = variantAnalytics.opportunities;

    // Calculate consumption percentage
    const pctConsumed = (sent / threshold) * 100;
    if (pctConsumed < LAST_VARIANT_WARNING_PCT * 100) continue;

    // Skip variants already past threshold (they'd be kills, not warnings)
    if (sent >= threshold) continue;

    warnings.push({
      warn: true,
      variantIndex: i,
      variantLabel: VARIANT_LABELS[i] ?? String(i),
      sent,
      threshold,
      remaining: Math.max(0, threshold - sent),
      pctConsumed: Math.round(pctConsumed * 10) / 10,
      opportunities,
    });
  }

  return warnings;
}
