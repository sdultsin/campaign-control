# Handoff: On-Demand Queue Trigger

**Date:** 2026-03-25
**Files changed:** `wrangler.toml`, `src/types.ts`, `src/index.ts`

## What Changed

Added a Cloudflare Queue-based on-demand trigger (`/__trigger`) that replaces the `/__scheduled` HTTP endpoint. The old endpoint was unreliable because Cloudflare kills fetch handlers after ~4-5 minutes, which is too short for a full CC run. The new `/__trigger` endpoint enqueues a message to the `cc-on-demand` queue, and the queue consumer executes `executeScheduledRun()` with full cron-level execution budget (15 minutes for paid Workers).

Specific changes:
- `wrangler.toml`: Added `cc-on-demand` queue producer and consumer bindings (max_batch_size=1, max_retries=0)
- `src/types.ts`: Added `ON_DEMAND_QUEUE: Queue` to the Env interface
- `src/index.ts`: New `/__trigger` endpoint (HTTP 202), deprecated `/__scheduled` (HTTP 410), new `queue()` handler on the default export

## Why

The `/__scheduled` fetch endpoint was getting killed mid-run by Cloudflare's execution time limits on HTTP handlers (~4-5 minutes). Queue consumers get the same execution budget as cron triggers (15 minutes), making them reliable for on-demand manual runs.

## How to Verify Post-Deploy

1. **Queue creation:** The `cc-on-demand` queue must be created in the Cloudflare dashboard (or via `wrangler queues create cc-on-demand`) before or during the first deploy. Wrangler may create it automatically on deploy.
2. **Trigger endpoint:** `curl -X POST https://auto-turnoff.<subdomain>.workers.dev/__trigger` should return HTTP 202 with message "Run queued..."
3. **Deprecated endpoint:** `curl https://auto-turnoff.<subdomain>.workers.dev/__scheduled` should return HTTP 410 with deprecation message
4. **Queue execution:** After triggering, check Cloudflare dashboard Queues tab for the message being consumed. Check #cc-admin for the run results. Console logs should show `on_demand_trigger` event with timestamps.
5. **Existing cron:** Verify the next cron run still fires normally (the `scheduled()` handler is untouched)

## Risk Assessment

- **Low risk:** No changes to `executeScheduledRun()`, evaluation logic, kill logic, safety rails, or any notification/dedup mechanisms. The queue handler calls the exact same function as the cron handler.
- **Queue must exist:** If the `cc-on-demand` queue doesn't get created, the `/__trigger` endpoint will fail at runtime when trying to send a message. Wrangler should create it on deploy, but verify.
- **No retries:** `max_retries = 0` means if the run fails, the message is dead-lettered. This is intentional - we don't want automatic retries that could cause overlapping runs. The KV lock provides additional protection.
