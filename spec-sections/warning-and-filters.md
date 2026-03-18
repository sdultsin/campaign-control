# Auto Turn-Off v2-v3: Early Warning, Campaign Filters, and Defensive Fixes

## Overview

This section specifies three additions to the auto turn-off system built on top of the v1 evaluator:

1. **Last Variant Early Warning** (v2, feature 2.2) - proactive Slack alert when a campaign is approaching auto-disable with no replacement variants queued
2. **OFF Campaign Filter** (v2) - skip campaigns parked by CMs before fetching analytics
3. **Defensive Coding Fixes** (v3) - guard against malformed campaign data that would cause silent failures or runtime errors

These are additive changes. The v1 evaluator contract (`evaluateStep` returning `{ kills, blocked }`) is preserved.

---

## 1. Last Variant Early Warning

### Problem

v1 alerts CMs after a variant is killed or blocked. By that point, the campaign may have zero active variants and zero replacement copy queued. The early warning system fires before the kill condition is met, giving CMs time to write and upload a new variant.

### Trigger Condition

A step qualifies for an early warning when ALL of the following are true:

- The step has exactly **1 active (non-disabled) variant**
- That variant has consumed **>= 80% of the kill threshold** in sends

The 80% threshold is a configurable constant. At the default threshold of 3,800 sends, this fires at 3,040 sends.

**Example:** Funding campaign on Google infra, threshold 3,800. The single active variant has 3,100 sends and 1 opportunity. `3,100 / 3,800 = 81.6%` consumed. Early warning fires.

**0-opportunity case:** If the last variant has >= 80% of threshold sends and 0 opportunities, the warning is critical - the variant is heading toward the "N sent, 0 opportunities" kill condition.

**Already-past-gate case:** If the variant has passed the gate but hasn't been killed yet (e.g., it has opportunities and hasn't triggered the ratio kill), the sends-based warning still applies. Sends approaching threshold is the primary signal.

### New Function: `checkLastVariantWarning`

Added to `evaluator.ts`. Called separately from `evaluateStep` - it does not affect the `kills`/`blocked` return value.

```typescript
export interface LastVariantWarning {
  warn: true;
  variantIndex: number;
  variantLabel: string;   // e.g. "A", "B", "C" derived from index
  sent: number;
  threshold: number;
  remaining: number;      // threshold - sent
  pctConsumed: number;    // 0-100, rounded to 1 decimal
  opportunities: number;
}

export function checkLastVariantWarning(
  step: Step,
  analytics: StepAnalytics[],
  stepIndex: number,
  threshold: number
): LastVariantWarning | null {
  // 1. Count active (non-disabled) variants
  const activeVariants = step.variants.filter((v) => v.v_disabled !== true);
  if (activeVariants.length !== 1) return null;

  // 2. Get the single active variant's index within the step
  const activeVariantIndex = step.variants.findIndex((v) => v.v_disabled !== true);

  // 3. Find this variant's analytics row
  const variantAnalytics = analytics.find(
    (a) => parseInt(a.step, 10) === stepIndex && parseInt(a.variant, 10) === activeVariantIndex
  );
  if (!variantAnalytics) return null;

  const sent = variantAnalytics.emails_sent_count ?? 0;
  const opportunities = variantAnalytics.opportunities_count ?? 0;

  // 4. Calculate consumption
  const pctConsumed = (sent / threshold) * 100;
  if (pctConsumed < 80) return null;

  return {
    warn: true,
    variantIndex: activeVariantIndex,
    variantLabel: String.fromCharCode(65 + activeVariantIndex), // 0→A, 1→B, etc.
    sent,
    threshold,
    remaining: Math.max(0, threshold - sent),
    pctConsumed: Math.round(pctConsumed * 10) / 10,
    opportunities,
  };
}
```

### KV Deduplication

Early warnings must not re-fire every run cycle for the same step. Use the existing KV store (same pattern as kill dedup).

**Key format:** `warning:{campaignId}:{stepIndex}`

**TTL:** 24 hours

**Logic:**
- Before sending the Slack alert, check KV for the key
- If key exists, skip notification (already alerted within 24h)
- If key does not exist, send alert and set key with 24h TTL

**Auto-expiry on recovery:** No explicit deletion needed. If a new variant is added and active count goes from 1 to 2+, `checkLastVariantWarning` returns `null` and the notification path is never reached. The KV key expires naturally. If the campaign is killed before 24h elapses, the KV key becomes irrelevant.

### Orchestrator Integration

In `index.ts`, inside the per-step loop, after `evaluateStep` returns:

```typescript
for (let stepIndex = 0; stepIndex < sequences[0].steps.length; stepIndex++) {
  const step = sequences[0].steps[stepIndex];
  const { kills, blocked } = evaluateStep(analytics, step, stepIndex, threshold);

  // --- v1: process kills and blocked (unchanged) ---
  for (const kill of kills) {
    // ... existing kill notification logic
  }
  if (blocked) {
    // ... existing LAST_VARIANT notification logic
  }

  // --- v2: early warning check ---
  // Only run if this step had no kills and no blocked variant.
  // If kills or blocked fired, the CM is already being notified about this step.
  if (kills.length === 0 && blocked === null) {
    const warning = checkLastVariantWarning(step, analytics, stepIndex, threshold);
    if (warning) {
      const dedupKey = `warning:${campaign.id}:${stepIndex}`;
      const alreadyNotified = await env.KV.get(dedupKey);
      if (!alreadyNotified) {
        await sendLastVariantWarningSlack(campaign, stepIndex, warning, workspaceName);
        await env.KV.put(dedupKey, '1', { expirationTtl: 86400 });
      }
    }
  }
}
```

The guard `kills.length === 0 && blocked === null` prevents double-notification. If v1 already fired a LAST_VARIANT alert (the variant hit the kill threshold), the early warning is redundant and suppressed.

### Slack Notification Format

New message type. Sent to the same channel as kill alerts.

```
:warning: Auto Turn-Off: Last variant approaching threshold

Workspace: {workspaceName}
Campaign: {campaignName}
Step {stepIndex + 1}, Variant {variantLabel} is the ONLY active variant

Emails sent: {sent} / {threshold} ({pctConsumed}% of auto-disable threshold)
Opportunities: {opportunities}

This variant will be auto-disabled when it hits {threshold} sends with insufficient opportunities.
Action needed: Add 1+ new variants to Step {stepIndex + 1} now.
```

**Slack Block Kit implementation:**

```typescript
async function sendLastVariantWarningSlack(
  campaign: Campaign,
  stepIndex: number,
  warning: LastVariantWarning,
  workspaceName: string
): Promise<void> {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *Auto Turn-Off: Last variant approaching threshold*`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Workspace:*\n${workspaceName}` },
        { type: 'mrkdwn', text: `*Campaign:*\n${campaign.name}` },
        {
          type: 'mrkdwn',
          text: `*Step ${stepIndex + 1}, Variant ${warning.variantLabel}* is the ONLY active variant`,
        },
        { type: 'mrkdwn', text: `\u200b` }, // spacer
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Emails sent:*\n${warning.sent.toLocaleString()} / ${warning.threshold.toLocaleString()} (${warning.pctConsumed}% consumed)`,
        },
        {
          type: 'mrkdwn',
          text: `*Opportunities:*\n${warning.opportunities}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `This variant will be auto-disabled when it hits *${warning.threshold.toLocaleString()}* sends with insufficient opportunities.\n*Action needed:* Add 1+ new variants to Step ${stepIndex + 1} now.`,
      },
    },
  ];

  await postToSlack({ blocks });
}
```

---

## 2. OFF Campaign Filter

### Problem

CMs prefix campaigns with "OFF" (sometimes preceded by calendar emojis) to indicate they are parked or paused. Fetching analytics and running evaluations on these campaigns wastes API quota and can generate erroneous kill notifications.

### Pattern Specification

The filter must match campaign names where "OFF" appears at the start of the meaningful text, after any leading emojis or whitespace. "OFF" must be followed by a space or dash - this prevents false matches on words like "Office" or "Offer".

**Must match (skip these):**
- `OFF - Moving Company(TOMI)`
- `📅OFF - Gyms...`
- `🗓️ OFF - Pair 2...`
- `📅 OFF - RG938...`

**Must NOT match (process these normally):**
- `Office Furniture - Pair 3`
- `Offer Campaign (ANDRES)`
- `ON - PAIR 1 - HVAC`

### Implementation

```typescript
/**
 * Returns true if the campaign should be skipped because it is marked OFF by a CM.
 * Matches "OFF" at the start of the name (after leading emojis/whitespace),
 * followed by a space or dash. Case-insensitive.
 */
function isOffCampaign(name: string): boolean {
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*OFF[\s\-]/iu.test(name);
}
```

**Regex breakdown:**
- `^` - anchored to start of string
- `[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]*` - zero or more leading emojis or whitespace (Unicode property escapes, requires ES2018+)
- `OFF` - literal, case-insensitive (`i` flag)
- `[\s\-]` - must be followed by whitespace or a dash (prevents "Office", "Offer" from matching)
- `u` flag - enables Unicode property escapes

**Note:** Cloudflare Workers runtime supports Unicode property escapes. If targeting an environment that does not, replace the emoji character class with a broader `[^\w]*` (zero or more non-word characters) as a safe fallback - this still prevents false positives on "Office" and "Offer" since they start with a word character.

### Placement in Orchestrator

In `index.ts`, inside the campaign processing loop, before fetching analytics or campaign details:

```typescript
for (const campaign of campaigns) {
  // Skip OFF campaigns before any API calls
  if (isOffCampaign(campaign.name)) {
    offCampaignCount++;
    continue;
  }

  // ... existing: fetch campaignDetail, analytics, run evaluator
}
```

### Workspace Summary Logging

Add `offCampaignCount` to the per-workspace summary log:

```typescript
let offCampaignCount = 0;

// ... campaign loop (increment offCampaignCount on each skip)

console.log(
  `[auto-turnoff] Workspace ${workspaceName}: ${campaigns.length} campaigns total, ` +
  `${offCampaignCount} skipped (OFF), ${processedCount} evaluated`
);
```

This provides an audit trail without cluttering logs with individual skip entries.

---

## 3. Defensive Coding Fixes

### 3a. Sequences Validation (index.ts)

**Problem:** v1 accesses `campaignDetail.sequences[0]` without checking whether `sequences` exists or is non-empty. A campaign with no sequences (newly created, archived, or in an unexpected state) will throw a runtime error, silently terminating processing for that workspace.

**Fix:** Add a guard before accessing `sequences[0]`:

```typescript
const campaignDetail = await fetchCampaignDetail(campaign.id);

if (!campaignDetail.sequences || campaignDetail.sequences.length === 0) {
  console.warn(
    `[auto-turnoff] Campaign ${campaign.id} (${campaign.name}) has no sequences, skipping`
  );
  continue;
}

const sequences = campaignDetail.sequences;
// safe to access sequences[0] from here
```

This converts a hard crash into a logged skip. The warning is queryable in Cloudflare Workers logs for diagnosis.

### 3b. Variant Index Bounds Logging (evaluator.ts)

**Problem:** The analytics payload from Instantly references variants by integer index. If the index is out of bounds for the step's variant array (e.g., a variant was deleted from the campaign after analytics were recorded), the existing `filter` silently drops the row. This can cause incorrect active variant counts and missed kills.

**Fix:** Add an explicit bounds check with a warning log inside the `activeAnalytics` filter:

```typescript
const activeAnalytics = analytics.filter((a) => {
  if (parseInt(a.step, 10) !== stepIndex) return false;

  const variantIdx = parseInt(a.variant, 10);
  const variant = step.variants[variantIdx];

  if (variant === undefined) {
    console.warn(
      `[auto-turnoff] Analytics references non-existent variant index ${variantIdx} ` +
      `in step ${stepIndex} (step has ${step.variants.length} variants). ` +
      `Analytics row: step=${a.step}, variant=${a.variant}, sent=${a.emails_sent_count}`
    );
    return false; // exclude from evaluation, same behavior as before but now logged
  }

  return variant.v_disabled !== true;
});
```

The fix preserves existing behavior (out-of-bounds rows are excluded) but surfaces the condition in logs. If this warning fires in production, it indicates a data consistency issue to investigate.

### 3c. `email_tag_list` Type Addition (types.ts)

**Problem:** `CampaignDetail` does not declare `email_tag_list`, which is returned by Instantly's API and used for infrastructure detection (Google vs. Microsoft sending accounts). Accessing it without a type declaration requires unsafe casting.

**Fix:** Add the optional field to `CampaignDetail`:

```typescript
export interface CampaignDetail {
  id: string;
  name: string;
  status: string;
  sequences: Sequence[];
  email_tag_list?: string[];  // Tag UUIDs identifying sending infrastructure (Google, Microsoft, etc.)
  [key: string]: unknown;     // Allow other undeclared fields from Instantly API
}
```

The `[key: string]: unknown` index signature is already present in v1 (or should be added alongside this change) to accommodate the full Instantly response without exhaustive typing.

---

## Data Flow Summary

```
index.ts: campaign loop
  |
  +-- isOffCampaign(campaign.name)?
  |     YES -> offCampaignCount++, continue
  |     NO  -> proceed
  |
  +-- fetchCampaignDetail()
  |     sequences empty? -> warn + continue
  |
  +-- fetchAnalytics()
  |
  +-- for each step:
  |     |
  |     +-- evaluateStep() [v1, unchanged]
  |     |     -> kills[], blocked | null
  |     |
  |     +-- process kills (existing logic)
  |     +-- process blocked (existing logic)
  |     |
  |     +-- if kills.length === 0 && blocked === null:
  |           checkLastVariantWarning()
  |             null      -> no action
  |             warning   -> KV dedup check
  |                           already notified? -> skip
  |                           new?              -> sendLastVariantWarningSlack()
  |                                               KV.put(key, 24h TTL)
  |
  +-- workspace summary log (includes offCampaignCount)
```

---

## Type Additions Summary

All new types are additive. No existing types are modified.

```typescript
// evaluator.ts - new export
export interface LastVariantWarning {
  warn: true;
  variantIndex: number;
  variantLabel: string;
  sent: number;
  threshold: number;
  remaining: number;
  pctConsumed: number;
  opportunities: number;
}

// types.ts - field addition to existing interface
export interface CampaignDetail {
  id: string;
  name: string;
  status: string;
  sequences: Sequence[];
  email_tag_list?: string[];   // new
  [key: string]: unknown;
}
```

---

## Constants

Add to a shared `constants.ts` or at the top of `evaluator.ts`:

```typescript
/** Fraction of kill threshold sends at which a last-variant early warning fires. */
export const LAST_VARIANT_WARNING_PCT = 0.8;

/** KV TTL in seconds for early warning dedup keys (24 hours). */
export const WARNING_DEDUP_TTL_SECONDS = 86400;
```

Using named constants makes the 80% threshold adjustable without hunting through logic code.
