# Current Notification System: Accuracy Audit

**Date:** 2026-03-16
**Audited by:** Automated agents cross-referencing live Instantly API data against Slack notifications
**Scope:** `notifications-[cm-name]` Slack Connect channels, operated by Outreachify's n8n automation
**Workspaces verified:** Renaissance 4 (Andres), Renaissance 5 (Marcos)

## Executive Summary

The current automated notification system sends variant performance alerts to Campaign Managers twice daily. An independent audit comparing these alerts against live Instantly data found that **every number reported is incorrect**. The root cause is a single API call that pulls workspace-wide aggregate data instead of per-campaign data, then stamps those aggregates onto every campaign in the CM's alerts.

This means CMs have been receiving, and potentially acting on, data that is 72x to 139x inflated compared to actual per-campaign numbers.

---

## What the System Currently Sends

Each notification run fires 3 alert types into per-CM Slack channels:

1. **Zero Opportunities Alert** -- Variants with sends > 0, opportunities = 0
2. **KPI Ratio Alert** -- Variants where sent/opportunities exceeds a threshold
3. **10k Volume Alert** -- Variants that have crossed 10,000 total sends

Runs fire twice daily (~4pm and ~10:30pm UTC). All three alerts appear under the same parent message: `:rotating_light: Variant Performance Alert`.

Note: Alert type 1 (Zero Opportunities) is a subset of type 2 (KPI Ratio). When opportunities = 0, the ratio is infinite. They are functionally the same check, split into separate messages because you cannot divide by zero.

---

## Finding 1: Workspace Aggregate Data Stamped on Every Campaign

**Severity: Critical**

The bot calls Instantly's `get_step_analytics` endpoint without passing a `campaign_id`. This returns the total sent/opportunities across the entire workspace, not for any individual campaign. The bot then copies these workspace totals into every campaign's alert block.

### Evidence: Renaissance 4 (Andres)

The workspace-level API returns:
- Step 0 / Variant 0: **373,897 sent, 105 opportunities**
- Step 1 / Variant 5: **21,612 sent, 2 opportunities**

The bot reports `Step 1 Variant A (sent 373,897, opps 104)` for the following campaigns, all with identical numbers:

| Campaign | Bot-Reported Sent | Actual Per-Campaign Sent | Inflation |
|----------|-------------------|--------------------------|-----------|
| OFF - PAIR 10 - REAL ESTATE | 373,897 | 2,698 | **139x** |
| ON - Landscaping Pair 2 | 373,897 | 2,878 | **130x** |
| ON - CLEANING Pair 3 | 373,897 | 3,785 | **99x** |
| OFF - PAIR 9 - CONSTRUCTION | 373,897 | 3,951 | **95x** |
| OFF - Health Pair 5 | 373,897 | 5,070 | **74x** |
| OFF - HVAC Pair 6 | 373,897 | 5,070 | **74x** |

The same pattern applies to `Step 2 Variant F (sent 21,612, opps 2)`, which also appears identically across 14 different campaign blocks.

### Evidence: Renaissance 5 (Marcos)

The workspace-level data includes:
- Step 2 / Variant 6: **8,208 sent, 0 opportunities**
- Step 3 / Variant 4: **3,043 sent, 0 opportunities**

The bot reports these exact numbers in the Zero Opportunities Alert for 5 different campaigns:
- OFF - Pair 5 - Restaurants: Step 3 Variant G (sent 8,208, opps 0)
- OFF - Pair 6 - Consulting Firms: Step 3 Variant G (sent 8,208, opps 0)
- ON - Pair 4 - Logistics: Step 3 Variant G (sent 8,208, opps 0)
- OFF - Pair 4 - Construction: Step 3 Variant G (sent 8,208, opps 0)
- ON - Pair 4 - Logistics: Step 4 Variant E (sent 3,043, opps 0)

These are not per-campaign numbers. They are workspace totals distributed across every campaign the CM owns.

---

## Finding 2: Alerts Firing for Deleted Campaigns

**Severity: Critical**

Two campaigns referenced in Marcos' alerts do not exist in any of the 13 searched workspaces:

| Campaign ID | Name in Alert | Search Result |
|-------------|--------------|---------------|
| `9db8a9ba` | ON - PAIR 3 - Healthcare (MARCOS) | Not found in any workspace |
| `6f31ebba` | ON - CONSTRUCTION (MARCOS) X | Not found in any workspace |

The bot has no pre-flight check for campaign existence. It maintains a stale list of campaign IDs and continues generating alerts for campaigns that have been deleted. The "Construction X" campaign was reportedly generating KPI alerts with numbers exceeding 1 million sends. These figures do not appear anywhere in the live workspace data.

This is what Leo reported: the bot sending notifications about dead campaigns.

---

## Finding 3: Draft/Inactive Campaigns Receiving Alerts

**Severity: High**

| Campaign | Bot Treats As | Actual Instantly Status |
|----------|--------------|------------------------|
| ON - Pair 4 - Logistics (Marcos) | Active (sends KPI alerts) | **draft** (zero sends) |

The bot reported a KPI ratio of 18,601:1 for this campaign. The campaign has never sent a single email. The 18,601:1 ratio comes from workspace aggregate data misattributed to it.

---

## Finding 4: OFF Campaigns Included in Alerts

**Severity: Medium**

Campaigns prefixed with "OFF" are a team naming convention indicating the campaign should not be active. The audit found:

- Every OFF-prefixed campaign checked is still `status: active` in Instantly (the name prefix does not change the platform status)
- The bot includes OFF campaigns in all three alert types
- CMs receive alerts telling them to act on campaigns the team has labeled as off

Examples from a single notification run for Andres:
- OFF - Home Improvement Pair 7 (ANDRES) X
- OFF - PAIR 9 - CONSTRUCTION (ANDRES)
- OFF - HVAC Pair 6 (ANDRES) X
- OFF - Health Pair 5 (ANDRES) X
- OFF - PAIR 10 - REAL ESTATE (ANDRES)
- OFF - PAIR 11 - GENERAL (ANDRES)
- OFF - PAIR 12 - Retail (ANDRES)

Seven of Andres' fourteen alerted campaigns are labeled OFF.

---

## Finding 5: No Deduplication Between Runs

**Severity: Medium**

Every run dumps every variant that currently meets the criteria. There is no tracking of what was already reported. A variant that crossed 10,000 sends a month ago still appears in every 10k Volume Alert, twice a day.

For Andres, a single notification run produces 3 parent messages, each containing 2-3 thread replies of 50+ line items spanning 14 campaigns. This repeats twice daily with near-identical content.

---

## Finding 6: Supabase Sync Broken

**Severity: High**

The Supabase table backing the notifications attributes all rows to a single campaign ID regardless of which campaign the data belongs to. A query across 10 distinct campaign IDs returned 50 rows all tagged to `385f1746` (OFF - Health Pair 5). The other 9 campaigns had zero rows.

This means any downstream reporting or dashboarding built on this Supabase data is also incorrect.

---

## Finding 7: KPI Math Is Correct, Inputs Are Wrong

The bot correctly calculates sent / opportunities. For example:
- 37,203 / 2 = 18,601 (bot reports 18,601) -- correct arithmetic
- 21,612 / 2 = 10,806 (bot reports 10,806) -- correct arithmetic

The division works. The numbers being divided are workspace aggregates, not campaign-specific values.

---

## What This Means

The notification system was built to give CMs visibility into which variants are underperforming so they can take action. In practice:

1. The data is wrong. Every number is a workspace aggregate, not a campaign metric.
2. Dead campaigns generate alerts. CMs are told to fix campaigns that no longer exist.
3. OFF campaigns generate alerts. CMs are told to act on campaigns the team considers inactive.
4. The same alerts repeat every run. No deduplication means signal drowns in noise.
5. The supporting database has the same data integrity issues.

The system cannot be relied on for operational decisions in its current state.

---

## How the New System (Auto Turn-Off) Addresses Each Finding

| Finding | Current System | Auto Turn-Off Build |
|---------|---------------|---------------------|
| Workspace aggregate leak | Calls API without campaign_id | Every `get_step_analytics` call scoped to a specific `campaign_id` |
| Deleted campaign alerts | No existence check | Try/catch per campaign; errors logged and skipped |
| Draft campaigns | No status filter | Only fetches `status: 'active'` campaigns from API |
| OFF campaign alerts | No name filter | Regex filter: `/^[\p{Emoji}]*OFF[\s\-]/` skips OFF-prefixed campaigns |
| No deduplication | Reports everything every run | KV-based dedup with 24h TTL for warnings; kills are one-time actions |
| Notification-only | Tells CM to act, no enforcement | Automatically disables underperforming variants with safety checks |
| Last variant protection | None | Safety check prevents killing the last active variant in any step |
| Per-infrastructure thresholds | Single threshold | Google 3,800:1, SMTP 4,500:1, Outlook 5,000:1 |
| Product-specific thresholds | None | ERC 6,000:1, S125 14,000:1, Warm Leads 500:1 |
| Audit trail | None | Every action logged to KV with 90-day retention, HTML dashboard at `/__dashboard` |

---

## Appendix: Audit Methodology

Two parallel agents were deployed, one per CM workspace:

1. **Agent 1 (Renaissance 5 / Marcos):** Searched 13 workspaces for Marcos campaigns, pulled per-campaign step analytics and campaign details, compared against bot's 2026-03-15 22:36 UTC notification data.

2. **Agent 2 (Renaissance 4 / Andres):** Same methodology for Andres campaigns. Additionally queried Supabase to verify data sync integrity.

Both agents independently discovered the same root cause (missing `campaign_id` parameter) before results were compared.

Tools used: Instantly MCP (`get_campaigns`, `get_step_analytics`, `get_campaign_details`), Slack MCP (`conversations_history`, `get_thread`).
