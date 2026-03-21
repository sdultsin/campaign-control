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
| `d6145dc` | 2026-03-21 ~15:00 UTC | Fix getCampaignAnalytics URL pattern | Fixes 100% error rate from `a1cbf1c`. Path param -> query param for `/campaigns/analytics`. cc-review checklist updated with item #9 (API contract correctness). |
