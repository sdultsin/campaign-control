# Auto Turn-Off Underperforming Variants

**Created:** [2026-03-14]
**Status:** Vision / Pre-build
**Product scope:** Business Lending only (for now)

---

## Problem

CMs spend ~1 hour/day manually checking every variant of every step of every campaign against KPI thresholds. Leo (30 campaigns, ~288 variants across 12 active) opens each campaign, calculates emails_sent / opportunities for each variant, sets hourly Notion reminders for variants approaching limits, and manually turns off underperformers. Pure drudgery across every CM.

**Previous attempt (Outreachify Slack bot):** Built to alert when variants exceeded threshold. Failed - notified about already-turned-off steps and deleted campaigns. Too much noise, nobody uses it. Lesson: don't alert, just act. Auto-turn-off with Slack as fallback only when action can't be taken.

---

## Core Logic (Post-Scrutiny v2)

```
EVERY HOUR:
  For each active campaign across all workspaces:
    Get step analytics (per-variant, with opportunities)
    For each variant in each step:
      1. GATE: if emails_sent < 4,000 -> SKIP (too early to evaluate)
      2. EVALUATE: if opportunities == 0 OR (emails_sent / opportunities > 4,000) -> KILL candidate
      3. SAFETY CHECK before killing:
         a. If this is the LAST active variant in the step -> DO NOT KILL -> Slack CM
         b. If killing would leave only 1 active variant in the step -> KILL it, BUT Slack CM
            "Step X now has only 1 active variant. Add variants to restore diversity
            and reduce deliverability risk."
      4. Execute kill
```

### Notification triggers (two distinct cases)

1. **Can't kill (last variant):** Variant exceeds threshold but it's the only one left. System does NOT kill. Slack CM: "This variant exceeded threshold but is the last one in this step. Add 1+ new variants and manually turn off."

2. **Killed down to 1 (deliverability risk):** System kills a variant, leaving only 1 active in the step. The survivor may be performing well and never trigger a kill - but running tens of thousands of follow-up emails through a single variant increases spam risk. Slack CM: "Step X now has only 1 active variant after auto-kill. Add variants to restore diversity."

### Why the gate works

The threshold IS the minimum sample size. At 4,000 emails, a variant has had a fair chance to generate at least 1 opportunity. No evaluation needed below 4,000. This eliminates the need for a separate "minimum sample" or "grace period" - new/replacement variants are automatically protected until they hit the threshold.

### v1 simplification (from scrutiny)

- **Universal 4,000 threshold.** CMs already use 4K generically. Per-infra differentiation (Google 3.8K, OTD 4.5K, Outlook 5K) deferred to v2 when Google Sheets MCP is connected.
- **CM name parsed from campaign name.** Convention: `[Tag] [Brand] [Industry] [CM Name]`. No separate mapping system needed. Falls back to shared channel if parser fails.
- **No explicit warm leads exclusion.** Warm leads have better ratios - they'll never trigger the kill threshold. Math handles it.
- **No warning zone.** CMs don't need to watch at 3.5K anymore. The system kills at 4K. Warning zones are vestigial from manual monitoring.

---

## KPI Thresholds (Business Lending)

### v1: Universal threshold
**4,000 emails/opportunity.** Kill any variant that exceeds this. What CMs already use.

### v2: Per-infrastructure thresholds (requires Google Sheets MCP)

| Infrastructure | Emails/Opportunity Kill Threshold |
|---------------|----------------------------------|
| Google | 3,800 |
| OTD (OutreachToday) | 4,500 |
| Outlook/Azure | 5,000 |

Source: [knowledge/kpi-framework.md](../../knowledge/kpi-framework.md) lines 152-160.

**Note on OTD vs SMTP:** CMs may call OTD "SMTP." Infrastructure doc lists three types: Google, OTD, Outlook. No explicit "SMTP" category. Confirm terminology with Ido or a CM.

---

## Slack Notifications

Two notification types. Both DM the CM responsible (parsed from campaign name, fallback to shared channel).

### Type 1: Last Variant Block (can't kill)

**Trigger:** Variant exceeds threshold but it's the LAST active variant in the step. System does NOT kill.

**Message:**
- Workspace, campaign, step, variant ID
- Current emails_sent and opportunities
- "This variant exceeded the kill threshold but is the last active variant in this step. Add 1+ new variants and manually turn off this one."

### Type 2: Single Variant Warning (deliverability risk)

**Trigger:** System kills a variant, and only 1 active variant remains in the step.

**Why this matters:** A surviving variant may perform well and never trigger a kill. But tens of thousands of follow-up emails flowing through a single variant increases spam detection risk. Low variant diversity = deliverability risk at scale.

**Message:**
- Workspace, campaign, step
- Which variant was killed (and why: emails_sent / opportunities)
- Which variant remains
- "This step now has only 1 active variant. Add new variants to restore diversity and reduce deliverability risk."

### Channel strategy
1:1 DM to the CM. CM name parsed from campaign naming convention (`[Tag] [Brand] [Industry] [CM Name]`). If parser can't extract a name, fall back to a shared notification channel.

---

## Inbox Type Matching (Dependency)

The kill threshold differs by inbox type. To apply the correct threshold per campaign, the system needs to know what inbox type each campaign uses.

**Current state:** Inbox sets (e.g., RG22784-RG22792) are labeled in a Google Sheet that CMs reference. Leo didn't even know what inbox type he was using - he defaulted to a generic 4,000 threshold.

**Required flow:**
1. Read inbox set labels from Google Sheet
2. For each campaign, identify which inbox sets are assigned
3. Map inbox set -> infrastructure type (Google/OTD/Outlook)
4. Apply the correct threshold

**Blocker:** Google Sheets MCP connection not yet established. Until connected, the system would need to either:
- Default to Google thresholds (strictest, 3,800) - conservative but over-kills on Outlook
- Use a hardcoded lookup table manually maintained - fragile
- Ask CMs to tag campaigns with infra type - adds burden

**Action item:** Set up Google Sheets MCP connection.

---

## No Kill Timestamp Logging

Decision: do NOT add timestamp logging when variants are killed. The data speaks for itself - a variant with 4,000 sent and 0 opportunities is obviously a killed variant. Adding logging complexity increases failure points.

If we need to teach a system to understand "why did variant C only get 4,000 sends while variant B got 13,000?" - the answer is always visible in the data: 4,000 sent + 0 opportunities = auto-killed. This can be handled downstream with interpretation logic, not upstream with event logging.

---

## Infrastructure: Hourly Cron

**Requirement:** Run every hour, poll Instantly API across all workspaces, process results, take action (turn off variants), send Slack DMs when needed. Must scale to all CMs.

**NOT n8n.** Outreachify's n8n setup is separate infrastructure. This needs to be independently owned and operated.

### Options Evaluated

| Option | Cost | Reliability | Simplicity | Fit |
|--------|------|-------------|------------|-----|
| **AWS Lambda + EventBridge** | ~$0.50/mo (free tier covers it) | Excellent (managed retries, dead-letter queues) | High | Best overall - proven for API polling workflows |
| **Cloudflare Workers + Cron Triggers** | Free (100k req/day) | Good | High | Strong contender - JS only, already have Cloudflare infra (CloudCrawl) |
| **Railway cron** | $5-20/mo | Good | Medium | Already used by Outreachify for MCP server |
| **Render cron** | $5-20/mo | Good | Medium | Container-based, higher cold starts |
| **Vercel cron** | Free-$20/mo | Good | High | JS focus, good for edge but API limits |
| **VPS + crontab** | $5-10/mo | Variable | Low | High maintenance, no auto-retry |

**Recommendation:** AWS Lambda + EventBridge or Cloudflare Workers. Both are serverless, near-free, and handle the hourly cadence cleanly. Cloudflare may be simpler since we already have Cloudflare infrastructure. AWS is more battle-tested for this exact pattern.

**Decision needed:** Which hosting platform to use.

---

## API Requirements (To Validate)

### Confirmed available via MCP:
- `get_step_analytics` - per-step/variant analytics with opportunities (include_opportunities param)
- `get_campaign_details` - sequences, schedule, settings
- `update_campaign` - generic updates object
- `get_all_campaigns` / `get_campaigns` - list campaigns per workspace
- `list_workspaces` - enumerate all workspaces

### Must validate:
1. **Can `update_campaign` toggle individual variants on/off?** The `updates` param takes a generic object. Need to probe the API to confirm variant-level control exists. Test on a non-production workspace.
2. **Does `get_step_analytics` return per-variant data (not just per-step)?** Tool description says "per-step/variant" but need to confirm the response shape.
3. **Can we identify which inbox sets are assigned to a campaign?** Need to check campaign details structure.
4. **Rate limits** - polling 22 workspaces x multiple campaigns hourly = potentially hundreds of API calls. Need to understand Instantly API rate limits (open question for Outreachify).

---

## Testing Plan

1. **Phase 0 (API validation):** Probe `get_step_analytics` and `update_campaign` on a test workspace to confirm variant-level control
2. **Phase 1 (Sam's workspace):** Run against one workspace with a few campaigns, observe behavior without actually killing (dry-run mode first)
3. **Phase 2 (Single CM pilot):** Deploy for one CM, monitor for 1-2 weeks
4. **Phase 3 (All CMs):** Scale to all workspaces/CMs

---

## Flags & Disclaimers

Things explicitly deferred or excluded from v1:

| Item | Status | Notes |
|------|--------|-------|
| **ERC KPI thresholds** | Deferred | 6,000/opp (from Ido). Different product, different thresholds. |
| **S125 KPI thresholds** | Deferred | 14,000/opp (from Ido). Much higher tolerance. |
| **Warm leads workspaces** | Excluded | Much higher results than cold - mixing would distort. Exclude entirely. |
| **Opportunity data lag** | Known risk | If IMs mark opportunities with delay, a variant could be killed despite having unreported opps. No mitigation in v1 - monitor during pilot. |
| **Google Sheets MCP** | Blocker for per-infra thresholds | Need connection to map inbox sets to infra types. Without it, can only use a single default threshold. |
| **20% over ratio buffer** | Skipped | KPI framework mentions it but we're using raw thresholds for simplicity. |
| **Single-variant deliverability risk** | Handled in v1 | When kills reduce a step to 1 variant, CM gets notified. Tens of thousands of emails through one variant = spam risk. |
| **CM-to-campaign mapping** | Solved | Parse from campaign naming convention. Fallback to shared channel if parser fails. Confirm naming is enforced by Samuel. |
| **OTD vs SMTP naming** | Unconfirmed | CMs may call OTD "SMTP." Need to confirm terminology alignment. |

---

## Source References

| Source | What it tells us |
|--------|-----------------|
| [kpi-framework.md](../../knowledge/kpi-framework.md) | Kill thresholds per infra type, variant decision framework |
| [infrastructure.md](../../knowledge/infrastructure.md) | Infra types (Google/OTD/Outlook), warmup protocols, rotation |
| [Leo CM discovery transcript](../../transcripts/2026-03-13%20Leo%20CM%20discovery%20-%20daily%20workflow%20bottlenecks%20and%20automation%20opportunities.md) | Leo's daily workflow, 1hr/day on variant checking, hourly alarms, 30 campaigns |
| [Ido spec feedback](../../../.claude/projects/-Users-sam-Documents-Claude-Code-Renaissance/memory/project_ido_spec_feedback_20260314.md) | ERC/S125 KPI corrections, product-level differences |
| [session log 2026-03-14](../../archive/session-logs/2026-03-14-data-dashboard-specs.md) | Origin of this workstream, not blocked on Outreachify |
