# Campaign Control (CC) Auto Turn-Off Worker

## What This Is

Cloudflare Worker that runs on cron (6am/12pm/6pm ET). Evaluates cold email campaigns across 18 Instantly workspaces, automatically kills underperforming variants, detects winners, monitors lead counts, and posts to per-CM Slack channels. After eval, Phase 7 self-audit runs 13 health checks and writes results to Supabase.

## Architecture

- **Runtime:** Cloudflare Worker (cron trigger)
- **Data source:** Instantly API (campaigns, analytics, leads) via MCP SSE + direct REST
- **State:** Cloudflare KV (kill dedup, rescan tracking, ghost exemptions, winner notifications)
- **Database:** Supabase (audit_logs, run_summaries, dashboard_items, audit_results, notifications, daily_snapshots, investigation_queue)
- **Notifications:** Slack Bot (per-CM channels + #cc-admin digest)
- **Dashboard:** Vercel-hosted HTML (cm-dashboard-sable.vercel.app, /admin for audit)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry. Cron handler, all phases (workspace loop, eval, Slack, Supabase, Phase 7) |
| `src/evaluator.ts` | Core kill/block/winner logic. Threshold comparison, last-variant protection |
| `src/config.ts` | All constants: thresholds, workspace configs, CM channel map, PILOT_CMS |
| `src/self-audit.ts` | Phase 7: 13 deterministic health checks, verdict logic (GREEN/YELLOW/RED) |
| `src/types.ts` | TypeScript interfaces (Env, CampaignResult, AuditResult, etc.) |
| `src/slack.ts` | Slack message formatting, grouped notifications, digest |
| `src/supabase.ts` | Supabase write helpers (audit_logs, run_summaries, dashboard_items) |
| `src/dashboard-state.ts` | Dashboard item lifecycle (upsert, resolve, stale cleanup) |
| `src/thresholds.ts` | Threshold resolution: per-provider, per-product, OFF buffer, opp runway |
| `src/leads-monitor.ts` | Lead count monitoring per campaign |
| `src/instantly-direct.ts` | Direct Instantly REST API calls (campaign analytics, variant status) |
| `src/instantly.ts` | MCP-based Instantly operations |
| `wrangler.toml` | Worker config, KV binding, cron schedule, env var bindings |

## Safety Rails

These exist to prevent bad kills. Never remove or weaken without explicit approval:

- **Kill cap:** 10 kills per CM per run (Map<string, number>)
- **7-day kill dedup:** KV key `kill:{campaignId}:{variant}` with 7-day TTL prevents re-killing
- **Last-variant protection:** Never kill if it's the only active variant in a campaign
- **Redemption Window:** 48h recheck for killed variants. Late-arriving opps can redeem and re-enable
- **Ghost exemption:** Campaigns that disappear from API get `exempt:` KV key, not killed
- **Graduated threshold:** Variants with opps > 0 get 10% more runway (OPP_RUNWAY_MULTIPLIER)
- **OFF campaign buffer:** 20% higher threshold for campaigns tagged OFF

## Supabase Tables

All tables use `worker_version` column. **Always filter WHERE worker_version = 'v2'** -- V1 data is unreliable.

| Table | Purpose |
|-------|---------|
| `audit_logs` | Individual kill/block/winner actions with full context |
| `run_summaries` | Per-run aggregates (campaigns evaluated, variants disabled, errors, duration) |
| `dashboard_items` | Active items per CM for the dashboard (kills, blocks, winners, warnings) |
| `audit_results` | Phase 7 self-audit results (verdict, 13 check results, trailing averages) |
| `notifications` | Slack messages sent per run |
| `daily_snapshots` | Daily aggregate numbers |
| `investigation_queue` | Layer 2 findings for autonomous fix pipeline |

## KV Key Prefixes

| Prefix | Purpose | TTL |
|--------|---------|-----|
| `kill:` | Kill dedup (campaignId:variant) | 7 days |
| `rescan:` | Redemption window recheck | 48 hours |
| `exempt:` | Ghost campaign exemption | 7 days |
| `ghost-notified:` | Ghost Slack notification dedup | 7 days |
| `winner-notified:` | Winner Slack notification dedup | 7 days |

## Threshold Logic

Kill threshold = max(provider_threshold, product_threshold). Provider: SMTP 4500, Google 3800, Outlook 5000. Products: Funding 4000, ERC 6000, S125 14000. Multipliers: OFF campaigns get 1.2x, variants with opps get 1.1x. Winner threshold = kill_threshold * 0.66 with minimum 5 opps.

A variant is killed when: sent >= threshold AND opportunities == 0 (or sent/opps ratio exceeds threshold with opp runway).

## Deploy Protocol

CRITICAL: Always deploy via deploy.sh. NEVER run `npx wrangler deploy` directly.
deploy.sh enforces 4 safety gates:
1. Must be on main branch
2. No uncommitted changes
3. Up-to-date with origin/main
4. HEAD must be descendant of last deployed version (no regressions)

If a gate blocks you: commit your work, push, pull latest, then retry.

    ./deploy.sh

After each deploy:
1. Confirm `src/version.ts` has the current git hash
2. Query any Supabase table for the latest row -- worker_version should be the git hash
3. Add the new version to VERSION_REGISTRY.md

## CC Review Checklist

Before any deploy, verify:
1. TypeScript compiles (`npx tsc --noEmit`)
2. Kill logic unchanged (or intentionally changed with spec)
3. Safety rails intact (kill cap, dedup, last-variant, redemption)
4. Supabase writes include worker_version
5. Slack messages formatted correctly
6. KV key patterns consistent
7. No hardcoded campaign IDs or CM names (use config)
8. Threshold logic matches spec
9. API contracts correct (path vs query params, response shapes)

## Rules

- NEVER disable safety rails without explicit Sam approval
- NEVER modify campaigns or variants in Instantly directly
- NEVER push to main without review
- NEVER deploy without running tsc first
- All notification types must have persistent KV dedup -- never re-alert after deploys
- When in doubt about kill logic, err on the side of NOT killing
