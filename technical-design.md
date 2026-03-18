# Auto Turn-Off v1: Technical Design Document

**Created:** [2026-03-15]
**Status:** Pre-build
**Companion docs:** [v1-spec.md](v1-spec.md) (product decisions), [phase-0-results.md](phase-0-results.md) (API validation), [cm-slack-mapping.md](cm-slack-mapping.md) (Slack user IDs)

This document captures every engineering decision, the reasoning behind it, edge cases considered, and assumptions made. It exists so that anyone revisiting this system - including future Claude sessions, Sam, or collaborators - can understand not just WHAT was built but WHY each choice was made.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Execution Flow](#execution-flow)
3. [API Call Optimization](#api-call-optimization)
4. [PATCH Safety Model](#patch-safety-model)
5. [Variant Identification & Matching](#variant-identification--matching)
6. [Decision Logic Implementation](#decision-logic-implementation)
7. [Error Handling Strategy](#error-handling-strategy)
8. [Concurrency & Rate Limiting](#concurrency--rate-limiting)
9. [Cron Overlap Prevention](#cron-overlap-prevention)
10. [Cloudflare Workers Constraints](#cloudflare-workers-constraints)
11. [Secret Management](#secret-management)
12. [Notification System](#notification-system)
13. [Dry-Run Mode](#dry-run-mode)
14. [Pagination](#pagination)
15. [Subsequences](#subsequences)
16. [Assumptions & Dependencies](#assumptions--dependencies)

---

## System Architecture

### Platform: Cloudflare Workers + Cron Triggers

**Decision:** Cloudflare Workers, not AWS Lambda.
**Why:** Sam already has Cloudflare infrastructure (CloudCrawl). Cron Triggers are built-in. $5/mo paid plan covers all limits. No AWS account/IAM setup needed.

**Plan required:** Workers Paid ($5/mo). Free plan limits (50 subrequests, 10ms CPU) are insufficient for ~260+ API calls per run.

### Language: TypeScript

**Why:** Native to Cloudflare Workers runtime. Strong typing for the complex variant/step/campaign structures reduces bugs. Same language as CloudCrawl.

### Standalone Deployment (not integrated into MCP)

**Why:** Auto-turn-off is a background automated process with zero CM interaction. CMs only receive Slack DMs - they never trigger, configure, or query this system. The King MCP speaks MCP protocol (JSON-RPC) designed for AI assistant tool calls, not service-to-service cron jobs. No downside to standalone. If v2+ adds CM-facing controls (e.g., "pause for my campaigns"), those commands could be added to the MCP at that time.

---

## Execution Flow

### High-Level Loop

```
EVERY HOUR (Cron Trigger):
  1. Acquire run lock (KV) -- prevent overlap
  2. For each Funding workspace (13 workspaces, sequential):
     a. List active campaigns (GET /campaigns?status=active)
     b. For each active campaign (parallel with concurrency cap):
        i.   GET step analytics (with opportunities)
        ii.  Check if ANY variant has sent >= 4,000 (quick gate filter)
        iii. If no variants above gate: skip campaign entirely
        iv.  If above-gate variants found:
             - GET full campaign details (sequences array)
             - Determine primary step count (sequences[0].steps.length)
             - Filter analytics to primary steps only (ignore subsequence steps)
             - Check v_disabled status of each variant
             - Filter out already-disabled variants from kill candidates
             - Re-evaluate with accurate active variant count per step
             - Apply safety check per step (never kill last active variant)
             - If DRY_RUN: log decision, skip PATCH
             - If LIVE: PATCH to disable, verify with GET
             - Queue Slack notification
     c. Send queued Slack notifications for this workspace
  3. Release run lock
  4. Log run summary
```

### Why Sequential Workspaces, Parallel Campaigns

Each workspace uses a different API key. Processing workspaces sequentially:
- Isolates failures (one bad key doesn't affect others)
- Naturally spreads load across different API key quotas
- Makes logging clearer (workspace-by-workspace)

Within a workspace, campaigns are independent and can be processed in parallel (with a concurrency cap to avoid rate limiting).

---

## API Call Optimization

### The Key Insight: Campaign Details Are Expensive and Usually Unnecessary

Most variants in most campaigns will be either:
- Below the 4K gate (SKIP) - no action needed
- Performing fine (ratio under 4K) - no action needed

Only variants that are kill candidates need the full campaign details fetch. This means:

| Call Type | When | Count per Run |
|---|---|---|
| List campaigns per workspace | Always | 13 |
| Step analytics per campaign | Always | ~238 |
| Campaign details (full sequences) | Only for kill candidates | ~10-30 (estimate) |
| PATCH to disable variant | Only for confirmed kills | ~0-10 (estimate) |
| GET to verify post-PATCH | After each PATCH | ~0-10 |
| **Estimated total** | | **~270-300** |

This is well under the 1,000 subrequest limit on Workers Paid.

### Why Not Pre-Fetch All Campaign Details?

Fetching details for all 238 campaigns would be ~476 calls (238 analytics + 238 details) before any PATCHes. That's wasteful since most campaigns won't have kill candidates. The two-phase approach (analytics first, details only for candidates) saves ~200 API calls per run.

---

## PATCH Safety Model

### The Risk (and why it's mitigated)

Instantly's PATCH `/api/v2/campaigns/{id}` replaces the entire `sequences` array. If we GET campaign details, then someone else modifies the campaign, then we PATCH, we overwrite their changes.

### Why This Is Safe for v1

**Operational rule (confirmed by Sam, 2026-03-15):** CMs do NOT edit variant copy after campaign launch. If they want to change copy, they create a new variant. The only mutation CMs make to existing variants is toggling them off - which is the same operation our system performs.

Concurrent toggle scenario: our system and a CM both try to disable variant B at the same time. Possible outcomes:
- CM disables first, our GET sees it as disabled, we skip it. **Correct.**
- Our GET runs before CM's disable, we PATCH to disable, CM's UI may show a brief inconsistency but the variant ends up disabled. **Correct.**
- Both PATCH simultaneously - last write wins, both set v_disabled: true. **Correct.**

### Additional Safety: Minimal PATCH Window

We only fetch campaign details AFTER confirming a kill candidate exists (from analytics). The GET-to-PATCH window is seconds, not minutes. The probability of a CM toggling the exact same variant in that window is near-zero.

### Assumption This Depends On

**CMs never edit variant copy on live campaigns.** If this rule is violated, data could be lost. Sam is communicating this to Samuel and the CM team. If enforcement is uncertain, v2 could add a checksum/hash comparison between GET and PATCH to detect concurrent modifications.

### DISCLAIMER: CM Copy-Edit Rule (CRITICAL)

**This system assumes CMs NEVER edit variant copy after campaign launch.** If a CM edits copy on a live campaign while the system is processing it, the edit will be silently overwritten. This applies to ANY system that modifies campaigns via the Instantly API - not just auto-turn-off, but any future automation (feedback loop, multi-armed bandit, etc.).

**Rule for CMs:** To change copy on a live campaign, CREATE A NEW VARIANT with the updated copy. Do not edit existing variant text. This preserves data attribution AND prevents race conditions with automated systems.

**Action item for Sam:** Communicate this rule to Samuel and the CM team before go-live. This is not optional - it's a data integrity requirement that affects both manual analytics AND automated systems.

### MCP vs Direct API: No Difference (confirmed 2026-03-15)

Investigated whether the King MCP's `update_campaign` tool handles the sequences replacement problem differently. Finding: **it's a thin passthrough.** The MCP sends the `updates` object directly to `PATCH /api/v2/campaigns/{id}` with zero merge intelligence. No variant-level tools exist in the MCP's 146-tool inventory. The full sequences replacement is a fundamental Instantly API design constraint, not something any wrapper can fix.

---

## Variant Identification & Matching

### How Analytics Map to Campaign Details

The step analytics endpoint returns objects with 0-indexed string identifiers:
```json
{ "step": "0", "variant": "0", "sent": 4200, "opportunities": 0 }
```

Campaign details store variants in nested arrays:
```
sequences[0].steps[0].variants[0]  // = analytics step "0", variant "0"
sequences[0].steps[0].variants[1]  // = analytics step "0", variant "1"
sequences[0].steps[1].variants[0]  // = analytics step "1", variant "0"
```

**The match is positional.** Analytics step 0 = details steps[0], variant 0 = variants[0].

### Assumption

Instantly maintains consistent ordering between the analytics response and the campaign detail arrays. Both derive from the same underlying data model - reordering would break their own UI. Phase 0 testing confirmed consistent ordering on Template D campaign.

### Verification

After every PATCH, we GET the campaign again and verify the target variant shows `v_disabled: true`. If the wrong variant is disabled, the verification step catches it. This is a safety net against ordering drift.

### Human-Readable Variant Labels

Analytics use 0-indexed numbers. CMs think in letters (A, B, C, D). The system must translate for notifications:
- variant 0 = A, variant 1 = B, variant 2 = C, variant 3 = D, etc.
- step 0 = Step 1, step 1 = Step 2, etc.

---

## Decision Logic Implementation

### Pseudocode

```typescript
function evaluateVariant(sent: number, opportunities: number): Decision {
  // Gate: too early to evaluate
  if (sent < THRESHOLD) return { action: 'SKIP', reason: 'Below minimum sends gate' };

  // Kill: zero opportunities or ratio exceeded
  if (opportunities === 0 || sent / opportunities > THRESHOLD) {
    return { action: 'KILL_CANDIDATE', reason: opportunities === 0
      ? `${sent} sent, 0 opportunities`
      : `Ratio ${sent}:${opportunities} = ${(sent/opportunities).toFixed(0)}:1 exceeds ${THRESHOLD}:1`
    };
  }

  // Keep: performing within threshold
  return { action: 'KEEP', reason: `Ratio ${sent}:${opportunities} = ${(sent/opportunities).toFixed(0)}:1` };
}
```

### Safety Check (before executing a kill)

```typescript
function safetyCheck(step: Step, killTargetIndex: number): SafetyResult {
  const activeVariants = step.variants.filter((v, i) =>
    !v.v_disabled && i !== killTargetIndex
  );

  if (activeVariants.length === 0) {
    // This is the LAST active variant - DO NOT KILL
    return { canKill: false, notify: 'LAST_VARIANT', remainingActive: 0 };
  }

  if (activeVariants.length === 1) {
    // Killing would leave only 1 - KILL but warn CM
    return { canKill: true, notify: 'DOWN_TO_ONE', remainingActive: 1 };
  }

  // Safe to kill, no notification needed
  return { canKill: true, notify: null, remainingActive: activeVariants.length };
}
```

### THRESHOLD Constant

v1: `const THRESHOLD = 4000;`

v2: This becomes a function of infrastructure type. The constant gets replaced with a lookup. One-line change in the evaluateVariant signature to accept a threshold parameter.

### Edge Case: Multiple Kill Candidates in One Step

If variants A, B, and C all exceed threshold in the same step, and only D is performing:
- Evaluate all three as kill candidates
- Safety check must account for ALL kills in this step, not evaluate each independently
- If killing all three would leave only D -> kill all three, but send "DOWN_TO_ONE" notification
- If killing all three would leave zero -> kill A and B (worst performers), keep C as last active, send "LAST_VARIANT" for C

**Implementation:** Collect all kill candidates per step first, sort by worst performance, then apply safety check iteratively.

---

## Error Handling Strategy

### Principle: Fail Gracefully, Don't Block

A single API failure should never prevent the rest of the run from executing. The system processes 13 workspaces and ~238 campaigns - one failure is noise, not a crisis.

### Error Isolation Levels

| Level | Failure Example | Response |
|---|---|---|
| Workspace | Bad API key, workspace deleted | Log error, skip workspace, continue to next |
| Campaign list | Pagination failure, timeout | Log error, skip workspace, continue to next |
| Analytics | Single campaign analytics timeout | Log error, skip campaign, continue to next |
| Campaign details | GET fails for kill candidate | Log error, skip this kill (picked up next hour), continue |
| PATCH | Disable fails (rate limit, server error) | Log error, DO NOT retry (picked up next hour), continue |
| Verification | GET after PATCH shows unexpected state | Log warning (possible API behavior change), continue |
| Slack | DM fails (rate limit, invalid user) | Log error, do NOT retry immediately, continue |

### No Retries in v1

**Why not retry?** The cron runs hourly. A failed campaign evaluation at 10:00 will be retried at 11:00 with fresh data. Retry logic adds complexity (exponential backoff, max attempts, partial state) for minimal benefit. The hourly cadence IS the retry mechanism.

**When retries would matter:** If a PATCH succeeds but verification fails, that's a potential consistency issue. But even then, the next hourly run will re-evaluate and catch any discrepancy. The system is self-healing by design.

### Logging Requirements

Every run must log:
1. **Run metadata:** timestamp, duration, workspace count, campaign count
2. **Per-workspace:** campaigns evaluated, errors encountered
3. **Per-campaign with action:** campaign name, step, variant, decision (SKIP/KEEP/KILL/BLOCKED), reason, sent count, opportunity count
4. **Errors:** full error message, which API call failed, which campaign/workspace

Cloudflare Workers logs are the primary destination. Viewable in real-time via `wrangler tail` or Cloudflare dashboard.

---

## Concurrency & Rate Limiting

### BOOKMARKED - Needs Input from Ido/Darcy/Instantly CTO

Instantly API rate limits are unknown. Sam will confirm with Renaissance's Instantly CTO contact.

### Current Design (Conservative)

- **Workspaces:** Sequential (one at a time). Each uses a different API key, so sequential processing avoids cross-key interference.
- **Campaigns within a workspace:** Parallel with concurrency cap. Default: 5 concurrent requests. Configurable via env var.
- **Slack notifications:** Sequential with 1-second delay between messages (Slack's standard rate limit is ~1 msg/sec/channel).

### Throttle Configuration

```
CONCURRENCY_CAP=5          // max parallel campaign evaluations per workspace
INTER_WORKSPACE_DELAY=500  // ms pause between workspaces (optional)
SLACK_MESSAGE_DELAY=1000   // ms between Slack messages
```

All configurable via environment variables. Can be tuned during pilot without code changes.

### Disclaimer

If Instantly imposes strict per-key rate limits (e.g., 60 requests/minute), the concurrency cap and inter-workspace delay will need adjustment. The system is designed to be tunable without code changes. Worst case: set CONCURRENCY_CAP=1 and process everything sequentially (~260 calls × 300ms avg = ~78 seconds total).

---

## Cron Overlap Prevention

### Problem

If a run takes longer than 1 hour (unlikely but possible with API slowness), the next cron trigger fires while the previous is still running. Two runs processing the same campaigns simultaneously could:
- Send duplicate Slack notifications (annoying, not dangerous)
- Both PATCH the same campaign (idempotent for v_disabled, but wasteful)

### Solution: KV-Based Lock

```typescript
async function acquireLock(kv: KVNamespace): Promise<boolean> {
  const existing = await kv.get('auto-turnoff-lock');
  if (existing) {
    const lockTime = parseInt(existing);
    // Lock expires after 30 minutes (stale lock protection)
    if (Date.now() - lockTime < 30 * 60 * 1000) {
      return false; // Another run is active
    }
  }
  await kv.put('auto-turnoff-lock', Date.now().toString());
  return true;
}
```

Lightweight, no external dependencies. KV is included with Workers Paid.

---

## Cloudflare Workers Constraints

### Limits (Workers Paid, $5/mo)

| Resource | Limit | Our Usage | Margin |
|---|---|---|---|
| CPU time per invocation | 30 seconds | ~2-5s (API calls are I/O wait, not CPU) | Comfortable |
| Wall-clock time (Cron) | 15 minutes | ~1-3 min estimated | Comfortable |
| Subrequests | 1,000 per invocation | ~270-300 | Comfortable |
| Memory | 128 MB | Minimal (JSON processing) | Comfortable |
| KV reads | 1,000/day free, then $0.50/million | ~1-2 per run (lock) | Negligible |
| KV writes | 1,000/day free, then $5/million | ~1-2 per run (lock) | Negligible |

### Why Not Free Plan

- 50 subrequest limit: we need ~270-300
- 10ms CPU time: too tight for JSON parsing across 238 campaigns
- No Cron Trigger support on free plan for >1 trigger

---

## Secret Management

### Structure

13 workspace API keys + 1 Slack bot token + configuration = too many individual env vars.

**Approach:** Single JSON secret for workspace config, separate secrets for Slack.

```
// Cloudflare Worker Secrets:
WORKSPACE_CONFIG = JSON string: [{ "id": "uuid", "name": "Renaissance 4", "apiKey": "key" }, ...]
SLACK_BOT_TOKEN = "xoxb-..."
SLACK_FALLBACK_CHANNEL = "C12345..."  // channel for campaigns with no parseable CM name (see Notification System > Fallback Channel)
CM_SLACK_MAP = JSON string: { "EYVER": "U08SLA1HQRZ", "ANDRES": "U0AD5EJPPC3", ... }

// Cloudflare Worker Env Vars (non-secret):
DRY_RUN = "true" / "false"
THRESHOLD = "4000"
CONCURRENCY_CAP = "5"
```

CM_SLACK_MAP is in KV (not a secret) so it can be updated without redeploying.

---

## Notification System

### Message Content

For a CM to act on a notification, they need to find the campaign instantly (no pun intended) without hunting through the UI.

#### Type 1: Last Variant Block

```
:warning: Auto Turn-Off: Cannot disable variant

Workspace: Renaissance 4
Campaign: ON - PAIR 11 - Property Management (ANDRES)
Step 3 (variant C)

This variant exceeded the kill threshold:
- Emails sent: 5,200
- Opportunities: 0
- Ratio: infinite (threshold: 4,000:1)

But it's the LAST active variant in Step 3. The system did NOT disable it.

Action needed: Add 1+ new variants to this step, then manually turn off variant C.
```

#### Type 2: Killed Down to 1

```
:rotating_light: Auto Turn-Off: Variant disabled, low diversity warning

Workspace: Equinox
Campaign: ON - RG1780 RG1781 - Angels Funding - From Ben 3 (LEO)
Step 1 (variant B) -> DISABLED

- Emails sent: 4,800
- Opportunities: 0

Step 1 now has only 1 active variant (variant A).
Running high volume through a single variant increases deliverability risk.

Action needed: Add new variants to Step 1 to restore diversity.
```

### Channel Delivery

v1 posts to per-CM `notifications-[name]` channels (see cm-slack-mapping.md). Uses `chat.postMessage` with `channel: CHANNEL_ID`.

### Fallback Channel

**Problem:** Many campaigns have no CM name in their title. From dry-run testing (236 campaigns, 13 workspaces), the following patterns have no parseable CM:
- ERC campaigns: `ERC 1`, `ERC 2`, `ERC 3`, `ERC 4`, `ERC 7`, `ERC Intent 1`
- Outlook 1 generic campaigns: `Auto - Google + others`, `Construction 2 - Outlook`, `Cleaning - Outlook`, `General 3`, `Advertising - Outlook`, `Auto - Outlook`
- Brand-only names: `Advertising - Google + Others`, `Construction - Google + Others`, `Cleaning - Google + Others`
- Mismatched patterns: `General (Ben's leads) RG2848...` (parses "Ben's leads" — not a known CM)
- Automated applications campaigns (no CM assigned)

**Decision:** All notifications for unmatched campaigns route to `SLACK_FALLBACK_CHANNEL`. This ensures no kill or last-variant-block goes unnoticed.

**Recommended channel:** Create a new `#notifications-unassigned` channel (or use an existing ops channel like `#funding-gtm`). Sam should monitor this channel. When a notification lands here, the campaign either needs a CM name added to its title or a workspace-level default CM assignment (v2 feature).

**If fallback is empty:** Slack API call will fail silently (logged as error). The variant kill still executes — only the notification is lost. This is acceptable in dry-run but must be set before going live.

---

## Audit Log

### Purpose

Every automated action (variant disabled or blocked) is persisted to Cloudflare KV as an append-only audit log. This provides a durable, queryable record of what the system did and why — independent of ephemeral Workers console logs.

### Log Entry Structure

Each entry is a JSON object stored in KV under key `log:{ISO timestamp}:{campaignId}:{stepIndex}:{variantIndex}`:

```json
{
  "timestamp": "2026-03-15T14:00:03.412Z",
  "action": "DISABLED",
  "workspace": "The Gatekeepers",
  "workspaceId": "the-gatekeepers",
  "campaign": "Healthcare - Pair 8 - RG2118/RG2119/RG2120/RG2121/RG2122 (BRENDAN)",
  "campaignId": "abc123",
  "step": 2,
  "variant": 0,
  "variantLabel": "A",
  "cm": "BRENDAN",
  "trigger": {
    "sent": 9147,
    "opportunities": 1,
    "ratio": "9147.0",
    "threshold": 4000,
    "rule": "Ratio 9147.0:1 exceeds threshold 4000:1"
  },
  "safety": {
    "survivingVariants": 2,
    "notification": "none"
  },
  "dryRun": false
}
```

For blocked actions (last variant), `action` is `"BLOCKED"` and `trigger.rule` explains why it wasn't killed.

### Storage

- **Where:** Same KV namespace as the run lock (`KV` binding)
- **Key format:** `log:{timestamp}:{campaignId}:{step}:{variant}` — lexicographically sortable by time
- **Retention:** KV entries are set with `expirationTtl: 90 * 86400` (90 days). Old entries auto-expire.
- **Querying:** Use `wrangler kv key list --prefix "log:"` to list all entries, or `--prefix "log:2026-03-15"` for a specific day

### Run Summary Log

Each completed run also writes a summary entry under key `run:{ISO timestamp}`:

```json
{
  "timestamp": "2026-03-15T14:00:17.267Z",
  "workspacesProcessed": 13,
  "campaignsEvaluated": 236,
  "variantsDisabled": 5,
  "variantsBlocked": 12,
  "errors": 0,
  "durationMs": 17267,
  "dryRun": false
}
```

---

## Dry-Run Mode

### Implementation

`DRY_RUN=true` environment variable.

When enabled:
- All reads execute normally (analytics, campaign details)
- All decisions are computed normally (gate, evaluate, safety check)
- **PATCHes are skipped** (variant remains enabled)
- **Slack DMs to CMs are skipped**
- All decisions are logged to Cloudflare Workers logs
- A run summary is logged at the end

### No Slack Dependency for Testing

Dry-run uses Cloudflare Workers logs exclusively. Sam can view logs via:
- `wrangler tail` (CLI, real-time)
- Cloudflare dashboard > Workers > Logs (web UI)

No Slack bot token, no admin access, no channel creation needed for dry-run testing. The bot token only becomes necessary when switching to live mode.

### Optional: Dry-Run Summary DM to Sam

If desired, dry-run could send a single summary DM to Sam's Slack user ID (`U0AM2CQHW9E`) with what WOULD have been killed. This requires the bot token but not admin access. Lower priority - Workers logs are sufficient.

---

## Pagination

**Tested (2026-03-15) via King MCP on The Gatekeepers (43 active campaigns):**

| limit param | Campaigns returned |
|---|---|
| 25 | 25 (truncated, no warning) |
| 50 | 43 (all) |
| 100 | 43 (all) |
| fetch_all: true | 43 (all) |

**Finding:** `limit` acts as a ceiling. No pagination tokens, cursors, or `has_more` fields in the response. A limit below the actual count silently truncates.

**v1 approach:** Use `limit: 100` on all list-campaigns calls. Current largest workspace is 43 active campaigns - 100 gives 2x+ headroom. If a workspace ever exceeds 100, campaigns would be silently missed.

**Caveat:** Tested through MCP wrapper, not direct REST API. Direct API pagination behavior should match but will be confirmed during testing with actual API keys.

**Future-proofing:** If Renaissance scales beyond 100 active campaigns per workspace, add a check: if returned count equals the limit, log a warning ("possible truncation - increase limit or add pagination").

---

## Subsequences

**Inspected (2026-03-15):** Campaign "ON 898-903 - Alex - Retail - (Bentora Capital)" in Renaissance 4.

### What Subsequences Are

Subsequences are **branch sequences** attached to a parent campaign. They trigger based on conditions (reply keywords, CRM status changes, lead activity events). They have their own steps, variants, delays, and schedules - identical structure to the primary sequence but managed independently.

Subsequences do NOT appear in the campaign list. They're nested under parent campaigns.

### Critical Finding: Analytics Bleed

**Subsequence steps appear in the step analytics response with higher indices.** If the primary sequence has 4 steps (indices 0-3), subsequence steps appear as step 4+. In the inspected campaign, a step 4 showed 1 send and 0 replies - likely a subsequence that barely triggered.

**If we naively evaluate ALL steps from analytics, we'd evaluate subsequence variants.** This would be incorrect for v1 (primary sequence only).

### v1 Implementation: Filter by Primary Step Count

```typescript
// Get primary step count from campaign details
const primaryStepCount = campaign.sequences[0].steps.length;

// Only evaluate analytics for primary steps
const primaryAnalytics = analytics.filter(a => parseInt(a.step) < primaryStepCount);
```

**Optimization note:** Most campaigns won't have subsequences, and subsequence steps typically have very low volume (caught by the 4K gate). But the filter is a 1-line safety check with zero cost.

### Flow Adjustment

This means we need the primary step count BEFORE filtering analytics. Two approaches:

**A) Fetch campaign details for every campaign** (simple but more API calls):
- Always GET campaign details after analytics
- Use step count for filtering and v_disabled for safety checks
- ~238 extra API calls per run

**B) Two-phase with heuristic** (efficient, slightly more complex):
- GET analytics first
- If ANY variant above gate: GET campaign details
- Use step count to filter subsequence steps
- Use v_disabled for safety checks
- Only ~30-50 extra API calls (campaigns with above-gate variants)

**Decision: Option B.** The gate (4K sends) naturally filters out most campaigns. Only campaigns with potential kills need details. The subsequence step count check happens at the same time as the v_disabled check - no extra API call.

### v3 Bookmark

Evaluating subsequence variants is deferred to v3. Subsequences are triggered by lead interactions (interested but didn't book, etc.), not cold outreach. They have different performance characteristics and likely don't need the same kill threshold. Requires MCP bug fix first (list_subsequences missing parent_campaign parameter - escalate to Outreachify).

### MCP Bug

`mcp__instantly__list_subsequences` fails with `"querystring must have required property 'parent_campaign'"`. The MCP tool schema doesn't expose the `parent_campaign` parameter. Add to Outreachify bug list.

---

## Assumptions & Dependencies

### Assumptions (things that must be true for the system to work correctly)

| # | Assumption | Validated? | Risk if Wrong |
|---|---|---|---|
| A1 | CMs never edit variant copy on live campaigns | Confirmed by Sam (2026-03-15). Being communicated to CM team. | PATCH could overwrite copy changes. Mitigated by minimal GET-to-PATCH window. |
| A2 | Analytics step/variant indexing matches campaign detail array ordering | Confirmed in Phase 0 on Template D. | Wrong variant gets disabled. Caught by post-PATCH verification. |
| A3 | `v_disabled: true` is the correct and stable field name for disabling variants | Confirmed in Phase 0. Not in official docs. | System silently stops working. Caught by post-PATCH verification returning unexpected state. |
| A4 | Analytics return cumulative stats (since campaign start), not windowed | Observed in Phase 0. | If windowed, a variant could reset below the gate after each window. Low risk - cumulative is standard for this type of metric. |
| A5 | Disabled variants still appear in analytics with their historical stats | Confirmed in Phase 0. | If disabled variants disappear from analytics, we lose the ability to detect "already disabled" without campaign details. Mitigated by the two-phase approach (details fetch for kill candidates). |
| A6 | Instantly API is available and responsive during cron execution | Assumed. | Run fails, picked up next hour. Self-healing by design. |
| A7 | Each Funding workspace has its own API key | Assumed. Darcy will confirm. | If workspaces share keys, concurrency model needs adjustment. |

### External Dependencies

| Dependency | Needed For | Status | Blocker? |
|---|---|---|---|
| Instantly API keys (13 Funding workspaces) | Direct API calls | Ask Darcy | Blocks testing, not build |
| Slack bot token | DM notifications | Ask Darcy | Blocks live mode, not dry-run |
| Cloudflare Workers Paid plan ($5/mo) | Subrequest limit, CPU time | Sam to set up | Blocks deployment |
| Instantly API rate limit info | Tuning concurrency cap | Ask Ido/Darcy/Instantly CTO | Doesn't block, can tune later |
| CM team briefing on copy-edit rule | Assumption A1 | Sam to communicate | Risk mitigation, not blocker |

---

## Changelog

| Date | Change | Reason |
|---|---|---|
| 2026-03-15 | Initial document | Pre-build technical design |
