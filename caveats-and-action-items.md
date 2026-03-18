# Auto Turn-Off: Caveats, Disclaimers, and Action Items

**Created:** [2026-03-15]
**Purpose:** Running list of things to verify, communicate, or revisit. Referenced during build and included in the final report to Ido.

---

## Verify with Ido

- [ ] **OTD distribution seems off.** Funding sheet shows 91% Google, 9% Outlook, 0% OTD. We know OTD exists at Renaissance (documented in infrastructure.md). Either OTD tags are warming up and not yet in the Funding sheet, or the sheet doesn't give the full picture. If tags are unmapped, per-infrastructure thresholds will fall back to the default. Confirm with Ido.
- [ ] **Warm leads threshold (500:1).** Approved based on data analysis (median 177:1, P90 389:1). Present to Ido for sign-off before adding this workspace to the system.
- [ ] **ERC/S125 thresholds.** 6,000:1 (ERC) and 14,000:1 (S125) confirmed as kill ceilings. No 20% buffer applied in v2. Disclaimer: these may need adjustment after observing live behavior.

## Verify with Samuel

- [x] **40% of Funding tags have no CM assigned.** Four workspaces (Renaissance 3, 6, 7, Outlook 3) have completely empty CM fields. **Resolved 2026-03-16:** Samuel confirmed these are warming up. 0 active campaigns in all four. Excluded from auto-turn-off config until they go live.
- [ ] **ERC: truly 100% Outlook?** The Inbox Hub ERC sheet shows all 50 tags as Outlook/MailIn. Verify this is accurate and not a data gap.
- [ ] **CM fields empty for ERC/S125.** ERC has 0% CM assignment, S125 has only 18% (Ido on oldest batches). Who manages these campaigns? Need at minimum a workspace-level owner for notifications.
- [ ] **No-edit-live-copy rule.** Before going live: Samuel must communicate to all CMs that launched variant copy/subject lines are never edited. Turn off the old variant and create a new one instead. (See roadmap "Hard Rule" section for full rationale.)

## Bookmark: Workspace Consolidation

Renaissance currently has 14 active Funding workspaces (4 warming excluded), 3 of which are shared between multiple CMs (Renaissance 4: 5 CMs, Renaissance 5: 3 CMs, The Eagles: 2 CMs). Shared workspace CM lists confirmed by Samuel 2026-03-16. Ideal state: each workspace owned by exactly 1 CM, where a CM may own multiple workspaces. This simplifies notification routing, accountability, and analytics.

**Action:** Phase out shared workspaces or redistribute campaigns so each workspace has a single owner. This is bigger than the auto-turn-off project -- it touches campaign structure, lead allocation, and CM assignments. Flag as a medium-term ops improvement, not a v2 build item. Potentially reduce total workspace count to 50-75% of current.

## Bookmark: Provider Code Mapping

The Instantly API returns `provider_code` on each account (confirmed: `2` = Google). Need to confirm what codes map to OTD and Outlook. One-time test: pull accounts from a known Outlook tag and a known OTD tag, check their `provider_code` values.

## Bookmark: OFF Campaigns

v1 and v2 skip campaigns with "OFF" in the title. These are campaigns that CMs consider paused but Instantly still returns as `status: active`. Current decision: don't evaluate them. Revisit if CMs complain about OFF campaigns accumulating bad variants that go unnoticed.

## Deployment Disclaimers (for final report)

- **First-run purge:** ~120 variants will be disabled on the first live run. Deployment is phased: validate 1 kill per CM first, confirm notifications work, then run the full purge. System enters autopilot after.
- **Thresholds are configurable.** All kill ceilings (Funding 4,000:1, ERC 6,000:1, S125 14,000:1, Warm Leads 500:1) are environment variables. Adjustable without code changes.
- **No 20% buffer.** KPI framework recommends 20% over ratio before cutting. v2 applies the ceiling directly (no buffer) per Ido's confirmation. If this is too aggressive, raise the thresholds.
- **Audit log retention.** All actions logged to Cloudflare KV with 90-day auto-expiry. Queryable by date, campaign, or action type.
- **Warm leads currently excluded.** The "Warm leads" workspace is not in the v1 whitelist. Will be added with the 500:1 threshold after Ido confirms.
