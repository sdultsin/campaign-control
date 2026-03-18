# Auto Turn-Off v1 Spec

**Created:** [2026-03-15]
**Status:** Vision / Pre-build
**Scope:** Funding workspaces only (Business Lending)

---

## Confirmed Decisions

### Scope
- **Funding workspaces only.** ERC, Section 125, and any non-Funding workspaces are excluded from v1.
- **Workspace-level filtering** (option 1) - whitelist of Funding workspace IDs. No campaign-name-based filtering needed for v1.
- **Only evaluate campaigns with Instantly API status = `active`.** Paused/completed/draft campaigns are skipped entirely.
- Variants already disabled (`v_disabled: true`) are skipped - no meta-logging of who turned them off.

### Threshold
- **Flat 4,000 emails/opportunity ceiling.** No per-infrastructure differentiation (Google/OTD/Outlook).
- **No 20% buffer.** Raw threshold only. Adding buffer later is a one-line change.
- Gate: if `emails_sent < 4,000` -> SKIP (too early to evaluate)
- Kill: if `emails_sent >= 4,000` AND (`opportunities == 0` OR `emails_sent / opportunities > 4,000`) -> KILL candidate
- Safety: never kill the last active variant in a step

### CM Name Parser
- Extract last parenthesized value from campaign name: `(CM_NAME)`
- Normalize to title case
- Strip trailing suffixes outside parens (X, NP, RB, etc.)
- Fallback for Lautaro-style: grab last `- NAME` token if no parenthesized name found
- If no CM name detected -> fall back to shared notification channel
- Known CM names from audit: EYVER, ANDRES, LEO, CARLOS, SAMUEL, IDO, Alex, Marcos, LAUTARO

### Notifications
- **Post to existing per-CM notification channels** (`notifications-[name]`), not DMs. 12 channels already exist with CMs added. See `cm-slack-mapping.md` for full channel ID map.
- Two notification types (unchanged from vision):
  1. **Can't kill (last variant):** variant exceeds threshold but it's the last active one
  2. **Killed down to 1 (deliverability risk):** system killed a variant, only 1 remains
- If CM name can't be parsed -> shared fallback channel (TBD)
- Replaces the broken `outreachify_bot` daily alerts (Darcy's Project 3). Ask Darcy to turn off old bot once our system goes live.
- **Bot token still needed from Darcy** - either the existing `outreachify_bot` token or a new bot added to all 12 channels.

### Infrastructure
- **Cloudflare Workers + Cron Triggers** - CONFIRMED (Sam will set up paid plan, $5/mo)
- **TypeScript**
- **Hourly cadence**
- **Standalone deployment** - not integrated into King MCP or any Outreachify system. Background process with zero CM interaction. No downside to standalone since CMs only receive Slack DMs.
- Dry-run mode via env flag (logs decisions to Cloudflare Workers logs, no Slack dependency)
- Full technical reasoning: see [technical-design.md](technical-design.md)

---

## Scale Numbers (sampled 2026-03-15)

| Metric | Count |
|---|---|
| Total workspaces | 22 (15 with campaigns, 7 empty/warming) |
| Active campaigns (all workspaces) | 266 |
| Paused campaigns | 73 |
| Est. API calls per hourly run | ~554 (~9-10/min) |

Top workspaces: The Gatekeepers (43), Renaissance 4 (28), The Eagles (26), Renaissance 5 (22), Equinox (21).

**Funding workspace whitelist - CONFIRMED (2026-03-15).** 13 Funding workspaces verified by sampling campaign copy via King MCP. All confirmed to be business lending (LOC/working capital).

Excluded: Section 125 1/2 (S125 product), ERC 1/2 (ERC product), Warm leads (warm lead follow-ups), Renaissance 3/6/7 + Outlook 3 (empty/warming).

**Bookmarked questions for Ido/CMs:**
- Outlook 1/2: are these infra-specific workspaces (Outlook-only inboxes) or just named that way? Affects v2 per-infra threshold logic.
- Automated applications: only 4 active campaigns, unusual name. Confirm this is standard Funding ops.
- Prospects Power, Koi and Destroy, The Gatekeepers: confirmed Funding by copy, but confirm with Ido these follow standard CM operational rules.

---

## API Architecture - DECIDED: Direct API Calls

### Why not MCP?
The King MCP speaks MCP protocol (JSON-RPC), not REST. A Cloudflare Worker cron job can't natively call MCP endpoints. Options were:
- A) **Direct Instantly REST calls from Worker** - simplest, same endpoints validated in Phase 0
- B) Ask Outreachify to add REST wrappers to their Railway server - dependency on them
- C) Build auto-turn-off INTO the Railway MCP server - requires their codebase access

**Decision: Option A.** Get API keys from Darcy/Outreachify, make direct calls. MCP is for interactive AI sessions; automated crons use REST.

**Action item:** Ask Darcy for Instantly API keys for all Funding workspaces. Bookmark as dependency.

### Slack Integration
- **Notification channels exist:** 12 per-CM private channels (`notifications-[name]`) already created by Darcy. Sam added to all 12. Channel IDs mapped in `cm-slack-mapping.md`.
- **Bot token needed:** Either the existing `outreachify_bot` token (already has channel access) or a new bot. Only needs `chat:write` scope (no DM scopes needed). Ask Darcy.
- **CM name -> channel ID mapping:** DONE. 12 CMs mapped. See `cm-slack-mapping.md`.
- Lookup table stored in Cloudflare KV (updatable without redeploy).
- Fallback channel for unmatched CM names (TBD - ask Sam which channel).
- **Outreachify's broken bot** should be turned off once our system goes live to avoid duplicate noise.

---

## Disclaimers & Operational Requirements

### CM Copy-Edit Rule (CRITICAL - communicate before go-live)
CMs must NEVER edit variant copy on a live campaign. To change copy, create a new variant. Editing existing copy on a live campaign:
1. Destroys data attribution (can't tell which copy generated which results)
2. Creates race condition risk with any automated system touching campaigns via API
3. Applies to ALL future automation, not just auto-turn-off

**Action:** Sam to communicate to Samuel and CM team before go-live.

### Rate Limiting (BOOKMARK - confirm before go-live)
~270-300 API calls per hourly run across 13 workspaces. System is tunable via env vars (CONCURRENCY_CAP, INTER_WORKSPACE_DELAY). Confirm safe levels with Ido, Darcy, or Instantly CTO contact.

---

## Bookmarked for v2/v3

### Per-Infrastructure Thresholds (v2)
- Google: 3,800 | OTD: 4,500 | Outlook: 5,000
- Requires: matching campaign account tags to inbox provider
- **API path confirmed (2026-03-15):** Campaign detail has `email_tag_list` (array of umbrella tag UUIDs). Each UUID maps to N accounts via `list_accounts(tag_ids=UUID)`. RG codes in campaign names are human convention - API uses broader group tags. To get per-infra type: campaign -> `email_tag_list` UUID -> cross-reference against Google Sheet.
- Dependency: Google Sheets MCP for the Funding sheet (column U = provider)
- Google Sheet: https://docs.google.com/spreadsheets/d/1wkrkX_02bdXaj_j-E03vLHIFRw8howadd96LOC4lONo/edit?gid=539226679#gid=539226679

### 20% Buffer (v2)
- KPI framework says "let each variant send 20% over ratio before making a cut decision"
- One-line change when ready: threshold becomes `4,000 * 1.2 = 4,800`

### Opportunity Lag Compensation (v2/v3)
- 4,000 sent with 0 opps today doesn't mean 0 opps forever - prospects may take days/weeks to respond
- IMs respond within ~10 minutes of prospect reply, but prospect response time varies wildly
- Need to investigate: avg time from email sent to opportunity booked + add buffer
- Possible data source: Thomas may be able to help with historical analysis
- Integration: could delay evaluation by X days after last email in batch was sent

### PAIR Definitions (v2)
- PAIRs are groupings of RG tags, but no formal definition found
- Ask Samuel or Ido where PAIRs are documented
- Needed for: understanding account-to-campaign mapping at scale

### Resting Campaign Evaluation (ask Ido)
- Should the system also evaluate paused/resting campaigns?
- Current decision: skip paused. But campaigns on rotation rest temporarily and will come back ON.
- When they come back ON, their cumulative stats include the resting period - so evaluation would resume normally.

### CM Response SOP (v2/v3)
- No SOP exists for how quickly CMs should add replacement variants after a kill
- Leo's behavior: exercises judgment, doesn't always replace immediately
- Needs CM discovery calls to understand patterns across team
- Could evolve into: system creates draft variants automatically (long-term vision)

### Non-RG Account Tags
- Some accounts (e.g., "Marcos Pair 3") don't follow RG naming
- Most accounts use RG prefix
- Ask CMs about non-standard tags

### ERC/S125 Thresholds
- ERC: 6,000/opp (from Ido)
- S125: 14,000/opp (from Ido)
- Would require separate workspace whitelists with different thresholds

---

## Campaign Naming Convention Audit (2026-03-15)

Audited 210+ campaigns across 7 workspaces. Two conventions coexist:

### PAIR-based (Andres, Samuel, some Alex, some Eyver)
```
ON/OFF - PAIR # - INDUSTRY (CM_NAME)
```

### RG-code-based (Leo, Carlos, Ido, some Eyver)
```
ON/OFF - RG#### RG#### - Brand - Industry (CM_NAME)
```

### Key findings
- CM name in parentheses at end = most consistent element (parser-friendly)
- ON/OFF prefix is common but not universal (Ido ignores it)
- ON/OFF in name does NOT reliably map to API status - use API status field
- RG code delimiters vary by CM: spaces, plus signs, slashes, commas
- Brand names included by some CMs, omitted by others
- Suffixes (X, NP, RB, GMAPS, WK, DM SN) are informal and undocumented
- Section 125 workspace uses completely different naming (job-title-based)

### Campaigns to be aware of (within Funding workspaces)
- Nurture campaigns: `Form Sent`, `No Show`, `Form Submitted/Awaiting Signature`
- Test campaigns: `TEST`, `Vicky Test Campaign`
- These are typically `completed` or `draft` status, so filtering by `active` should exclude most

---

## Open Questions (Pre-Build)

| # | Question | Ask Who | Status |
|---|----------|---------|--------|
| 1 | Which workspace IDs are "Funding" workspaces? | Sam/Ido | **BOOKMARK** - Sam will get to this next |
| 2 | MCP vs direct API for production cron? | -- | **DECIDED** - Direct API calls. Need API keys from Darcy. |
| 3 | Slack bot token | Darcy | **BOOKMARK** - Renaissance has bots, need token for testing |
| 4 | CM name -> Slack user ID mapping | -- | **DONE** - See cm-slack-mapping.md (11 CMs mapped) |
| 5 | Account tag visibility via API? | -- | **ANSWERED** - `email_tag_list` field on campaign detail. Umbrella tag UUIDs, not individual RG codes. See v2 bookmark. |
| 6 | Rate limits for Instantly API? | Ido/Darcy/Instantly CTO | **BOOKMARK** - ~270-300 calls/hr (optimized). Need to confirm safe concurrency level. System is tunable via env vars without code changes. Disclaimer in spec: concurrency cap may need adjustment based on rate limit feedback. |
| 7 | PAIR formal definitions? | Samuel/Ido | **BOOKMARK** - v2 |
| 8 | Should resting campaigns be evaluated? | Ido | **BOOKMARK** - v1 skips paused |
| 9 | Unclear workspace classification | Sam/Ido | **BOOKMARK** - Outlook 1/2, Automated applications, Prospects Power, Koi and Destroy, The Gatekeepers: Funding or not? |
| 10 | Fallback Slack channel for unmatched CMs | Sam | **BOOKMARK** - which channel? |
