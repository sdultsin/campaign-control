# CC Version Registry

Agents: when you see a `worker_version` value in Supabase, look it up here to understand what code produced it and what data quality issues apply.

## How versioning works

- Each deploy generates a git short hash as the version tag via `deploy.sh`
- The tag is written to all 5 Supabase tables in the `worker_version` column
- To inspect the exact code: `git show <hash>` or `git log --oneline <hash>`
- To see which specs were active: compare deploy date against `specs/` directory

## Version History

### Legacy versions (pre-automated tagging)

| Version | Period | Description | Known Data Issues |
|---------|--------|-------------|-------------------|
| `NULL` / missing | Pre 2026-03-18 | V1 era, all MCP, original build | All data unreliable. Wrong thresholds, missing version tags. Never use for decisions. **Normalized 2026-03-20:** tagged as `v1`, steps +1 (now 1-indexed). |
| `v2` | 2026-03-18 to 2026-03-20 | Direct API for step analytics, MCP for leads | Multiple deploys share this tag. Behavior varies by time window. **Normalized 2026-03-20:** all pre-fix rows (before 13:43 UTC) steps +1 (now 1-indexed). |

#### v2 time windows

| Window | Deploy | Changes | Known Issues |
|--------|--------|---------|--------------|
| 2026-03-18 to 2026-03-19 ~15:00 UTC | Initial v2 | Direct API mode, MCP for leads | Supabase writes dropped (fire-and-forget race). Steps 0-indexed. No BLOCKED entries in audit_logs. |
| 2026-03-19 ~15:00 to ~22:00 UTC | Dry-run tests | Testing direct API | dry_run=true on all entries. Test data. |
| 2026-03-19 ~22:00 UTC | 4840a9a1 | BLOCKED entries written, MCP reconnect | leads_checked=0 (MCP still failed). Steps 0-indexed. |
| 2026-03-20 ~10:00 UTC | Crashed run | 6am cron | Run crashed mid-Phase-3. run_summaries and daily_snapshots MISSING. audit_logs present (166 entries). |
| 2026-03-20 ~13:43 UTC | 7b378479 | Step indexing 1-indexed, skip disabled variants, leads direct API | Steps 1-indexed (inconsistent with earlier v2). skipped=0 in leads audit. |

**Querying v2 data:** always filter by timestamp for accuracy issues. Steps are now 1-indexed across all versions after the 2026-03-20 normalization migration (see `specs/cc-data-normalization.md`).

### Automated versions (git hash tagging)

<!-- After each deploy, add a row: version hash, deploy datetime (UTC), specs included, known issues. -->

| Version | Deployed (UTC) | Specs Included | Known Data Issues |
|---------|---------------|----------------|-------------------|
| `7b95a92` | 2026-03-20 ~20:00 UTC | cc-version-tagging, skip-disabled-variants, leads-direct-api | First automated version tag. KILLS_ENABLED=false. **leads_checked always 0** -- getBatchCampaignAnalytics reads `c.id` but API returns `campaign_id`, so leads phase silently skips all campaigns. Variant evaluation data is accurate. |
| `87d06fa` | 2026-03-20 ~16:30 UTC | Fix campaign_id field mapping in leads batch analytics | Fixes leads phase: `c.id` -> `(c.campaign_id ?? c.id)`. First version with working leads monitoring in direct API mode. KILLS_ENABLED=false. |
| `fa255ed` | 2026-03-21 ~04:00 UTC | batch-surviving-count, grouped-notifications, send-accuracy-and-kill-cap, KILLS_ENABLED=true | Grouped Slack notifications. Batch surviving variant count fix. Date-filtered step analytics (campaign timestamp_created). Send count sanity check (skip kills when step 1 sent > contacted * 1.1). Kill cap budget counter (fixes concurrent race condition). KILLS_ENABLED=true. |
| `a1cbf1c` | 2026-03-21 ~05:00 UTC | (version tag update only) | Same source code as `fa255ed`. Commit only adds VERSION_REGISTRY entry + handoff doc. No behavior change. **BUG: getCampaignAnalytics uses wrong URL pattern (`/campaigns/{id}/analytics` path param instead of `/campaigns/analytics?campaign_id=` query param), causing 100% campaign errors (62/62). Zero kills executed. Sanity check never completes.** |
| `d6145dc` | 2026-03-21 ~15:00 UTC | Fix getCampaignAnalytics URL pattern | Fixes 100% error rate from `a1cbf1c`. Path param -> query param for `/campaigns/analytics`. cc-review checklist updated with item #9 (API contract correctness). Deployed as `0d78ca0` (version tag commit on top). |
| `5e18a9b` | 2026-03-21 ~20:45 UTC | off-campaign-20pct-buffer | OFF campaigns now evaluated (no longer skipped). Thresholds multiplied by 1.2 for OFF campaigns. Kill/blocked/warning Slack notifications annotated with "OFF campaign — threshold raised 20%". Expect first-run volume spike as previously-invisible OFF campaigns enter evaluation. |
| `ff07af8` | 2026-03-21 ~22:30 UTC | remove-date-filter | Removes date filter (startDate/endDate) from main evaluation getStepAnalytics call. Date-filtered API drops opportunities, caused 5 false kills in 8am run. Sanity check (step 1 sent vs contacted) already handles sent inflation. All call sites now consistently unfiltered. |
| `1802bf2` | 2026-03-22 ~00:30 UTC | lead-count-fix | Fixes false EXHAUSTED/WARNING verdicts caused by analytics `contacted_count` being a lifetime accumulator. Phase 3 now uses MCP `count_leads` per campaign instead of batch analytics. `active` count = true uncontacted. Audit entries now log real active/skipped values. ~15-20s slower (per-campaign vs batch). |
| `c6a99c7` | 2026-03-22 ~afternoon UTC | cm-supervision-console, slack-suppression | CM dashboard state (Phase 5): `dashboard_items` + `resolution_log` tables, `buildDashboardState()` upserts BLOCKED/LEADS issues. Morning digest cron at 12:00 UTC (8am ET). **All per-item Slack notifications suppressed** -- `flush(skipSlack=true)` writes to Supabase only, no Slack API calls during eval scans. Only Slack message is the 8am daily digest. Notification records have `thread_ts: null`, `reply_success: false`. |
| `153b508` | 2026-03-22 ~20:30 UTC | leads-error-downgrade | Separates Phase 3 MCP leads errors into `leadsCheckErrors` counter (new `leads_check_errors` column in run_summaries). MCP countLeads failures logged as warnings, not errors. Fixes inflated `errors` field (was = campaigns_evaluated since `1802bf2` due to MCP SSE failures from Cloudflare edge → Railway). Leads monitoring still non-functional until MCP connectivity is resolved. |
| `0def5ae` | 2026-03-22 ~22:30 UTC | cc-graduated-threshold | Variants with opps > 0 get 10% extended threshold (threshold * 1.1) before kill. Zero-opp path unchanged. Stacks with OFF buffer: OFF + opps = base * 1.32. `effective_threshold` recorded in audit trigger JSONB and dashboard_items context JSONB. Also includes dashboard dismiss field resets (`dismissed_at: null`) on re-detection and `resolution_method: 'auto'` in resolution_log. |
| `18aaf70` | 2026-03-22 ~22:45 UTC | leads-direct-api-batch | Replaces broken MCP `countLeads()` in Phase 3 with batch analytics (`getBatchCampaignAnalytics`). 1 API call per workspace instead of N MCP calls. Computes `active = leads_count - completed - bounced - unsubscribed` (skipped=0, clamped to >=0). MCP fallback preserved for non-direct mode. **Approximate:** analytics status fields may be lifetime accumulators for campaigns with lead cycling -- errs toward more false EXHAUSTED/WARNING (safe direction). Accurate endpoint TBD (pending Outreachify MCP source investigation). |
| `a8d9667` | 2026-03-23 ~12:45 UTC | lautaro-pilot-cm | Adds LAUTARO to PILOT_CMS and CM_MONITOR_CHANNELS (#cc-lautaro = C0AMXSTGEF9). Lautaro manages The Eagles (shared workspace) alongside Samuel. Campaigns routed via `- LAUTARO` suffix fallback pattern. No logic changes. |
| `8a74345` | 2026-03-23 ~22:00 UTC | pre-expansion-fixes | **Fix 1 (CRITICAL):** processWithConcurrency returns CampaignResult[], sequential tally eliminates lost-increment races across 25+ shared variables. **Fix 2:** RE_ENABLED audit gated on enableVariant success. **Fix 3:** Warning dedup key written in dry-run mode (fixes 9x inflation). **Fix 4:** Dashboard step off-by-one fixed. **Fix 5:** Rescan + persistence monitor KV list pagination. **Fix 6:** variantsKillsPaused separated from variantsBlocked (new column + Supabase write). killBudgetRemaining kept shared (bounded race, self-correcting). |
| `c90bbb5` | 2026-03-23 ~23:30 UTC | scale-winners | Winner detection: variants with ratio <= kill_threshold * 0.66 flagged as WINNING (INFO severity) on CM dashboard. Permanent KV dedup (`winner:notified:{campaignId}:{step}:{variant}`, no TTL). Morning digest includes top performers (last 24h). Leads-exhausted cross-reference appends note. Roll-up notifications for all-variants-winning steps (3+) and multi-step campaigns (2+). Dashboard dismissed WINNING items stay dismissed (CM "Done" = permanent). CampaignResult pattern: winners/winnersDetected on result, tallied in sequential loop. Supabase: `winners_detected` column on run_summaries. No new API calls. Informational only -- no Instantly writes. |
| `d7a5055` | 2026-03-24 ~18:00 UTC | ghost-reenable-fix | **Fix 1:** Silent `.catch(() => {})` on GHOST_REENABLE audit writes replaced with verbose error logging (surfaces root cause of Supabase write failure). **Fix 2:** `ghost_details` JSONB column added to `run_summaries` -- stores workspace/campaign/step/variant/CM/dates for each ghost, eliminating manual investigation. **Fix 3:** Ghost exemption -- `exempt:{campaignId}:{step}:{variant}` KV key (90d TTL) prevents CC from re-killing CM-re-enabled variants. Checked alongside kill dedup at Phase 2 execution. **Fix 4:** Ghost Slack notification to CM channel (`:ghost:` emoji, deduped via `ghost-notified:` KV key, 90d TTL). Fires in all modes (informational). New KV prefixes: `exempt:`, `ghost-notified:`. |
| `b240192` | 2026-03-24 ~23:30 UTC | winner-min-opps-5 | WINNER_MIN_OPPS raised from 2 to 5 (Ido directive). Variants with <5 opportunities no longer qualify as winners. Existing dashboard WINNING items with <5 opps will auto-resolve on next cron run via `resolveStaleItems`. No new API calls, no new KV prefixes. |
