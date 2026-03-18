# Auto Turn-Off: Roadmap

**Created:** [2026-03-15]
**v1 status:** Build complete, dry-run verified, awaiting deployment dependencies.

---

## v2: Precision + Visibility

These features make the system smarter and give CMs/leadership better visibility into what's happening.

### 2.1 Per-Infrastructure Thresholds
**What:** Replace the flat 4,000:1 threshold with infrastructure-specific ceilings from the KPI framework.
**Why:** Google (3,800:1), OTD (4,500:1), and Outlook (5,000:1) have different deliverability profiles. The flat threshold over-kills Outlook variants and under-kills Google variants.
**How:** Use `email_tag_list` on campaign detail to identify infrastructure type (tag -> account -> ESP). Phase 0 already confirmed the field exists. One-line change in evaluateVariant to accept a per-campaign threshold.
**Dependency:** Google Sheets MCP (already connected) for tag-to-infrastructure mapping, or hardcode the mapping.

### 2.2 Last Variant Early Warning
**What:** Alert CMs when the last remaining active variant in a step is trending toward the kill threshold. Show how many emails remain until auto-disable (or what % of the ceiling has been consumed). Include a recommendation to add more variants before the system is forced to act.
**Why:** The "last variant" deadlock is the most important failure mode to prevent — the system cannot act when only one variant remains, so catching it early is critical. This replaces the graduated milestone alert approach (multiple checkpoints at 2,800 / 3,000 / 3,500 etc.) which generates noise CMs ignore and doesn't change behavior.
**How:** On each run, check if a step has exactly one active variant. If it's trending toward threshold (e.g., 80%+ consumed), emit a single targeted Slack alert with remaining sends shown numerically. Track "alerted" state in KV to avoid repeat notifications until the variant resets or is replaced.

### 2.3 Workspace-Level Default CM
**What:** Map workspaces to a default CM for notifications when campaign title parsing fails.
**Why:** Dry-run showed many un-tagged campaigns (ERC, Outlook generics). Workspace-level defaults catch most of these since workspaces are typically owned by one CM or a small team.
**How:** Add `WORKSPACE_CM_MAP` to config. Parser falls back to workspace CM before the global fallback channel.
**Status:** Sam is reaching out to Samuel to map which CMs manage which workspaces. This workspace-level mapping becomes the **primary lookup** — campaign title parsing is the fallback for shared workspaces where multiple CMs operate.

### 2.4 Audit Log Dashboard
**What:** An on-demand view where you can browse all auto-turn-off actions day by day. A simple page or tool — not a Slack notification.
**Why:** Sam and leadership need a single place to see the system's activity without reading individual Slack alerts. On-demand access is more useful than a daily push notification that lands at an arbitrary time.
**How:** Serve a lightweight HTML page from the Cloudflare Worker that reads and renders the KV audit log, grouped by date. No new data storage required — the audit log entries are already written on each action.

---

## v3: Depth + Intelligence

These features extend the system's reach into areas v1 deliberately excluded. v2 and v3 are being built in unison.

### ~~3.1 Subsequence Evaluation~~ — REMOVED
Subsequences in Instantly do not support variants (single email per step). No A/B testing = nothing to evaluate or auto-disable. Confirmed via Perplexity research and Sam's manual verification (2026-03-15).

### 3.2 ERC and S125 Product-Specific Thresholds
**What:** Apply different KPI ceilings for ERC campaigns (6,000:1) and S125 campaigns (14,000:1) vs standard Funding (4,000:1).
**Why:** Different products have different conversion economics. Killing an ERC variant at 4,000:1 is too aggressive.
**How:** Parse product type from campaign name or workspace. Apply product-specific thresholds. Ido confirmed these numbers (2026-03-14).

### 3.3 Warm Leads Workspace Exclusion
**What:** Exclude the "Warm leads" workspace from evaluation entirely, with product-specific KPI thresholds informed by actual performance data.
**Why:** Warm leads have fundamentally different performance characteristics. Ido flagged this explicitly (2026-03-14). However, the right thresholds for warm leads require data — not assumptions.
**How:** Add to exclusion list in config. Currently the workspace is already filtered out by not being in FUNDING_WORKSPACE_NAMES.
**Pre-work:** Before adjusting thresholds, Sam will analyze warm leads campaign performance data to propose realistic KPI numbers to Ido. Those get validated and adjusted by infrastructure type (Google/OTD/Outlook) before being wired into the system.

---

## Hard Rule: No Editing Live Variant Copy

**This must be communicated to Samuel and the CM team before going live.**

When a variant is created and the campaign is launched, the copy and subject line are locked. CMs must NOT edit the copy or subject line of any live variant. The only allowed actions are:
- **Keep it on** (let it run)
- **Turn it off** (disable the variant)
- **Create new variants** (add fresh copy as a new variant)

**Why this matters:** The auto-turn-off system (and any future automation that touches campaigns via the Instantly API) works by downloading the full campaign, modifying a single field, and uploading the entire thing back. If a CM edits copy between the download and upload, their edit is silently overwritten with no trace. This is an Instantly API constraint, not something any wrapper can fix.

**Enforcement:** Samuel to communicate this as a hard rule to all CMs. If a variant's copy needs to change, turn off the old variant and create a new one with the updated copy. This also preserves clean analytics attribution -- edited copy muddies the performance data for that variant.

---

## Deployment Plan: Initial Purge

The first live run will identify ~120+ variants above the kill threshold. Rather than flooding CMs with notifications all at once:

**Phase 1: Validation (1 kill per CM)**
- Set a temporary cap of 1 kill per CM per run
- Trigger the first live run
- Confirm with each CM that they received the Slack notification and understand the format
- Verify the variant was actually disabled in Instantly UI

**Phase 2: Full purge**
- Once all CMs confirm notifications are working, remove the per-CM cap
- Trigger a full run that clears the backlog (~120 variants)
- Monitor logs and Slack channels for any issues

**Phase 3: Autopilot**
- System runs hourly on cron, catching new variants as they cross the threshold
- Expected volume: 1-3 kills per run at steady state

---

## Operational Prerequisites (before going live)

These are non-technical items that must be completed before switching `DRY_RUN=false`:

- [ ] **Slack bot token** — from Darcy (either existing `outreachify_bot` or new bot added to `notifications-*` channels)
- [ ] **Fallback channel** — create `#notifications-unassigned` or choose an existing ops channel, add bot to it
- [ ] **Cloudflare Workers paid plan** — $5/mo, purchase at dash.cloudflare.com > Workers & Pages > Plans
- [ ] **No-edit-live-copy rule** — Samuel communicates to all CMs before system goes live (see Hard Rule section above)
- [ ] **KV namespace** — `wrangler kv namespace create KV`, paste ID into wrangler.toml
- [ ] **OFF campaigns** — v1 skips campaigns with "OFF" in the title. CMs should be aware that paused-but-active campaigns won't be evaluated. (Revisit in v2 if needed.)
- [ ] **Warm leads threshold (500:1)** — approved, but confirm with Ido before adding this workspace to the system
- [ ] **ERC/S125 thresholds** — 6,000:1 and 14,000:1 confirmed as ceilings, no 20% buffer applied. Disclaimer: these may need adjustment after observing live behavior.

---

## Back Burner: v4+ Ideas and Extensions

Features that go beyond auto-turn-off into broader automation. Deprioritized while v2 and v3 are being built. Some align with Ido's automation doc projects.

### 4.1 Auto-Ramp / Volume Management (Ido's Project 4)
**What:** Automatically adjust cold email and warmup volume per inbox based on lifecycle phase (warmup -> ramp -> active -> OFF month rotation).
**Why:** CMs forget to adjust volume every 2-3 days. Inbox Hub Sheet is perpetually inaccurate. Sending capacity isn't fully utilized.
**Overlap:** Shares infrastructure with auto-turn-off (Cloudflare Worker, MCP connection, workspace iteration). Could be a second cron job in the same Worker.
**Complexity:** High. Requires inbox lifecycle state machine, Inbox Hub Sheet sync (Google Sheets MCP), manual approval checkpoints for phase transitions.

### 4.2 Idle Inbox/Tag Detection (Ido's Project 5)
**What:** Detect inboxes or tags not assigned to any active campaign and notify CMs.
**Why:** Wasted infrastructure spend. Inboxes cost money even when idle.
**Overlap:** Same workspace iteration pattern. Could piggyback on auto-turn-off's hourly scan.
**How:** After fetching campaigns, compare assigned tags against all tags in workspace. Alert on unassigned.

### 4.3 Reply Data Collection (Ido's Project 1)
**What:** Collect 100% of replies across all workspaces into centralized storage (Airtable per Ido's doc, but could be Supabase).
**Why:** Foundation for everything downstream -- reply scoring, lead quality scoring, AI agents.
**Relationship to auto-turn-off:** Separate system, but the reply data would eventually feed better kill decisions (e.g., kill based on reply quality, not just opportunity count).

### 4.4 IM Reply Time Tracking (Ido's Project 2)
**What:** Measure how fast inbox managers reply to prospect messages, per workspace.
**Why:** Performance tracking and QA for the IM team.
**Relationship to auto-turn-off:** Independent system. Could share the Cloudflare Worker infra.

### 4.5 Auto-Rewrite Suggestions
**What:** When a variant is killed, use the reply/opportunity data to suggest why it failed and what a replacement variant should look like.
**Why:** CMs currently get "variant killed" notifications but no guidance on what to write next. This closes the loop.
**Dependency:** Reply data collection (4.3) and some form of copy analysis. Feeds into the broader feedback loop / multi-armed bandit system.

### 4.6 Campaign Health Score
**What:** A single score per campaign (0-100) combining variant performance, step falloff rates, reply quality, and deliverability signals.
**Why:** CMs manage 15-40+ campaigns each. A health score lets them prioritize which campaigns need attention.
**How:** Aggregate the per-variant evaluations already computed by auto-turn-off into a campaign-level metric. Display in a dashboard or daily digest.

### 4.7 Predictive Kill Alerts
**What:** Predict which variants will hit the kill threshold in the next 24-48 hours based on send velocity and current opportunity rate.
**Why:** Earlier warning than 2.2. CMs get a "this variant will be auto-disabled tomorrow unless it gets an opportunity" heads-up.
**How:** Track send velocity (sends per hour) from consecutive runs. Extrapolate time-to-threshold.

### 4.8 CM Performance Dashboard
**What:** Per-CM view showing their campaigns, variant health, kill/block history, and response time to notifications.
**Why:** Samuel (team lead) and Ido need visibility into which CMs are responsive to notifications and which are letting variants burn.
**How:** Aggregate audit log by CM. Track time between "last variant" notification and CM adding new variants.

---

## Priority

| Priority | Feature | Impact | Effort |
|----------|---------|--------|--------|
| **Now** | Deploy v1 live | Stops ~120 variants burning money today | Low (just needs Darcy's bot token) |
| **Active (v2+v3)** | 2.1 Per-infra thresholds | Stops over-killing Outlook, under-killing Google | Medium |
| **Active (v2+v3)** | 2.2 Last variant early warning | Prevents last-variant deadlock before it happens | Low (extend existing evaluator) |
| **Active (v2+v3)** | 2.3 Workspace-level default CM | Correct CM routing for un-tagged campaigns | Low (config + Samuel mapping) |
| **Active (v2+v3)** | 2.4 Audit log dashboard | Leadership visibility on demand | Low (Cloudflare Worker HTML page) |
| ~~Removed~~ | ~~3.1 Subsequences~~ | ~~No variants in subsequences~~ | ~~N/A~~ |
| **Active (v2+v3)** | 3.2 ERC/S125 thresholds | Correct product-specific decisions | Low (config change) |
| **Active (v2+v3)** | 3.3 Warm leads exclusion | Requires performance data analysis first | Low after analysis |
| **Active** | Redemption Window | Disabled variants get 48h to prove themselves via late-arriving opps | Complete (code) |
| **Back burner** | 4.1-4.8 | High complexity or depend on reply data infrastructure | High |
