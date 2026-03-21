# Kill Persistence Monitor — Build Spec

**Date:** 2026-03-18
**Depends on:** `specs/kill-persistence-monitor-tdd.md`
**Codebase:** `builds/auto-turn-off/src/`

---

## Agent Breakdown

Two agents. Change A (batch kills) restructures the kill execution flow in `index.ts`. Change B (persistence monitor) adds a new phase. They touch the same file but different sections, so they run sequentially.

```
[Agent A: Batch kills — index.ts + types.ts] --> tsc --noEmit
[Agent B: Persistence monitor — index.ts + types.ts + slack.ts] --> tsc --noEmit
```

---

## Shared Context

### Current kill flow (index.ts, lines ~590-750)

Kills are executed INLINE during the variant evaluation loop:
```
for each workspace:
  for each campaign:
    fetch campaignDetail
    fetch stepAnalytics
    for each step:
      for each variant:
        evaluate → if KILL_CANDIDATE:
          if under MAX_KILLS_PER_RUN:
            disableVariant() ← INDIVIDUAL API CALL
            verify
            write audit log
            send notification
            queue rescan
          else:
            log as DEFERRED
```

### Critical rules

- DO NOT change `evaluator.ts`, `slack.ts` (except adding ghost notification), `router.ts`, `thresholds.ts`, `leads-monitor.ts`, or `mcp-client.ts`
- DO NOT change any KV key formats for existing keys
- DO NOT change notification formats for existing notification types
- The persistence monitor must be non-blocking — if it fails, the rest of the worker continues

---

## Agent A: Batch Kills Per Campaign

**Model:** sonnet
**Files:** `src/index.ts`, `src/types.ts`
**Estimated diff:** ~80 lines changed

### Concept

Replace the inline kill execution with a two-phase approach within each campaign's processing:

**Phase 1a (evaluate):** Collect kill candidates into a list — don't execute yet.
**Phase 1b (execute):** After all variants in a campaign are evaluated, batch-execute all kills in one `update_campaign` call.

### index.ts changes

Find the section where individual kills are executed (approximately lines 590-750). The current code structure is:

```typescript
// Inside the campaign loop, inside the variant loop:
if (decision.action === 'KILL_CANDIDATE') {
  // ... safety check ...
  if (runKillCount < MAX_KILLS_PER_RUN) {
    // INLINE KILL: disable, verify, audit, notify, rescan
  } else {
    // DEFERRED
  }
}
```

Change to:

```typescript
// Before the step/variant loops:
const pendingKills: Array<{
  kill: KillAction;
  auditEntry: AuditEntry;
  stepIndex: number;
  channelId: string;
}> = [];

// Inside the variant loop — COLLECT instead of execute:
if (decision.action === 'KILL_CANDIDATE') {
  // ... safety check (unchanged) ...
  if (runKillCount < MAX_KILLS_PER_RUN) {
    pendingKills.push({ kill: killAction, auditEntry, stepIndex, channelId });
    runKillCount++;
    // DO NOT call disableVariant here
  } else {
    // DEFERRED (unchanged)
  }
}

// AFTER the step/variant loops (still inside the campaign loop):
if (pendingKills.length > 0) {
  // 1. Fetch FRESH campaign details (single read)
  const freshDetail = await instantly.getCampaignDetails(workspace.id, campaign.id);
  const cloned = structuredClone(freshDetail.sequences);

  // 2. Apply all disables to the clone
  for (const pk of pendingKills) {
    const v = cloned?.[0]?.steps?.[pk.stepIndex]?.variants?.[pk.kill.variantIndex];
    if (v) v.v_disabled = true;
  }

  // 3. Single update_campaign call
  let batchSuccess = false;
  try {
    await mcp.callTool('update_campaign', {
      workspace_id: workspace.id,
      campaign_id: campaign.id,
      updates: { sequences: cloned },
    });

    // 4. Single verification
    const verified = await instantly.getCampaignDetails(workspace.id, campaign.id);
    batchSuccess = true;

    // 5. Check each variant individually
    for (const pk of pendingKills) {
      const v = verified.sequences?.[0]?.steps?.[pk.stepIndex]?.variants?.[pk.kill.variantIndex];
      const isDisabled = v?.v_disabled === true;

      if (isDisabled) {
        // SUCCESS: write audit, notify, queue rescan (existing code, moved here)
        // ... existing audit log write ...
        // ... existing notification send ...
        // ... existing rescan queue write ...
        // ... existing dedup key write ...
        workspaceKills++;
        totalVariantsKilled++;
      } else {
        console.warn(`[auto-turnoff] Batch verify failed: ${campaign.name} step=${pk.stepIndex} variant=${pk.kill.variantIndex}`);
      }
    }
  } catch (err) {
    console.error(`[auto-turnoff] Batch kill failed for ${campaign.name}: ${err}`);
    // Fallback: try individual kills
    for (const pk of pendingKills) {
      try {
        const success = await instantly.disableVariant(workspace.id, freshDetail, pk.stepIndex, pk.kill.variantIndex);
        if (success) {
          // ... same audit/notify/rescan logic ...
        }
      } catch (individualErr) {
        console.error(`[auto-turnoff] Individual kill fallback failed: ${individualErr}`);
      }
    }
  }
}
```

**Key details:**
- The `mcp` variable is in scope (it's declared at the top of the `scheduled` handler)
- `KILLS_ENABLED` check stays — wrap the batch execution block in `if (killsEnabled)`
- When `KILLS_ENABLED=false`, log "KILLS PAUSED" for each pending kill (unchanged behavior)
- Kill dedup check (`alreadyKilled`) moves to the collect phase (before pushing to `pendingKills`)
- The `runKillCount` increment stays in the collect phase to respect `MAX_KILLS_PER_RUN`

### types.ts changes

No changes needed for batch kills.

---

## Agent B: Kill Persistence Monitor (Phase 4)

**Model:** sonnet
**Files:** `src/index.ts`, `src/types.ts`
**Estimated diff:** ~100 lines added

### types.ts changes

Add `GHOST_REENABLE` to the AuditEntry action union:

```typescript
action: 'DISABLED' | 'BLOCKED' | 'WARNING' | 'RE_ENABLED' | 'EXPIRED' | 'CM_OVERRIDE' | 'DEFERRED' | 'MANUAL_REVERT' | 'GHOST_REENABLE';
```

### index.ts changes

Add Phase 4 after Phase 3 (leads monitor), before the run summary is written.

**Location:** After the leads monitor phase completes (search for the run summary construction), insert before it.

```typescript
// -----------------------------------------------------------------------
// PHASE 4: KILL PERSISTENCE MONITOR
// -----------------------------------------------------------------------
console.log('[auto-turnoff] Phase 4: Kill persistence monitor');
let ghostCount = 0;
const MAX_PERSISTENCE_CHECKS = 20;
let persistenceChecks = 0;

try {
  // 1. List all kill dedup keys from KV
  //    Key format: kill:{campaignId}:{stepIndex}:{variantIndex}
  const killKeys = await env.KV.list({ prefix: 'kill:' });

  // 2. Group by campaignId
  const killsByCampaign = new Map<string, Array<{
    key: string;
    campaignId: string;
    stepIndex: number;
    variantIndex: number;
    killedAt: string;
  }>>();

  for (const key of killKeys.keys) {
    if (persistenceChecks >= MAX_PERSISTENCE_CHECKS) break;

    const raw = await env.KV.get(key.name);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw) as {
        campaignId: string;
        stepIndex: number;
        variantIndex: number;
        killedAt: string;
      };

      const list = killsByCampaign.get(data.campaignId) ?? [];
      list.push({ key: key.name, ...data });
      killsByCampaign.set(data.campaignId, list);
      persistenceChecks++;
    } catch { continue; }
  }

  // 3. For each campaign, check if kills persisted
  for (const [campaignId, kills] of killsByCampaign) {
    const firstKill = kills[0];
    // Resolve workspace from config (need to find which workspace owns this campaign)
    // We stored the workspace in the rescan entry but not in the kill key.
    // Use the rescan key if available, otherwise skip.
    const rescanKey = `rescan:${campaignId}:${firstKill.stepIndex}:${firstKill.variantIndex}`;
    const rescanRaw = await env.KV.get(rescanKey);
    let workspaceId: string | null = null;
    let workspaceName = '';
    let cmName: string | null = null;
    let campaignName = '';
    let product: string = 'FUNDING';

    if (rescanRaw) {
      try {
        const rescan = JSON.parse(rescanRaw) as RescanEntry;
        workspaceId = rescan.workspaceId;
        workspaceName = rescan.workspaceName;
        cmName = rescan.cmName;
        campaignName = rescan.campaignName;
        product = rescan.product;
      } catch { /* skip */ }
    }

    if (!workspaceId) {
      console.log(`[auto-turnoff] Persistence check: no workspace found for campaign ${campaignId}, skipping`);
      continue;
    }

    try {
      const detail = await instantly.getCampaignDetails(workspaceId, campaignId);
      campaignName = campaignName || detail.name;

      for (const kill of kills) {
        const variant = detail.sequences?.[0]?.steps?.[kill.stepIndex]?.variants?.[kill.variantIndex];
        if (!variant) continue;

        if (variant.v_disabled !== true) {
          // GHOST RE-ENABLE DETECTED
          ghostCount++;
          const variantLabel = VARIANT_LABELS[kill.variantIndex] ?? String(kill.variantIndex);

          console.warn(
            `[auto-turnoff] GHOST RE-ENABLE: ${campaignName} Step ${kill.stepIndex + 1} ` +
            `Variant ${variantLabel} was disabled at ${kill.killedAt} but is now enabled`
          );

          const ghostAudit: AuditEntry = {
            timestamp: new Date().toISOString(),
            action: 'GHOST_REENABLE',
            workspace: workspaceName,
            workspaceId,
            campaign: campaignName,
            campaignId,
            step: kill.stepIndex,
            variant: kill.variantIndex,
            variantLabel,
            cm: cmName,
            product: product as any,
            trigger: {
              sent: 0,
              opportunities: 0,
              ratio: '0',
              threshold: 0,
              rule: `Ghost re-enable: disabled at ${kill.killedAt}, found enabled at ${new Date().toISOString()}`,
            },
            safety: {
              survivingVariants: -1,
              notification: null,
            },
            dryRun: isDryRun,
          };

          await writeAuditLog(env.KV, ghostAudit).catch(() => {});
          if (sb) writeAuditLogToSupabase(sb, ghostAudit).catch(() => {});

          // Clean up the kill dedup key since the variant is no longer disabled
          await env.KV.delete(kill.key).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[auto-turnoff] Persistence check failed for campaign ${campaignId}: ${err}`);
    }
  }
} catch (err) {
  console.error(`[auto-turnoff] Phase 4 persistence monitor error: ${err}`);
}

if (ghostCount > 0) {
  console.warn(`[auto-turnoff] Phase 4 complete: ${ghostCount} ghost re-enables detected`);
} else {
  console.log(`[auto-turnoff] Phase 4 complete: all ${persistenceChecks} kills verified persistent`);
}
```

**Also update the RunSummary type and construction** to include ghost count:

In types.ts, add to RunSummary:
```typescript
ghostReEnables: number;
```

In the run summary construction (near end of scheduled handler), add:
```typescript
ghostReEnables: ghostCount,
```

In supabase.ts writeRunSummaryToSupabase, add:
```typescript
ghost_re_enables: summary.ghostReEnables,
```

(Supabase column `ghost_re_enables` will need to be added via migration.)

---

## Verification

After making all changes:

```bash
cd builds/auto-turn-off && npx tsc --noEmit
```

Must compile with zero errors.

### Manual verification after deploy

1. Trigger a manual run (`/__scheduled`)
2. Check logs for "Phase 4: Kill persistence monitor"
3. If any kills exist in KV, confirm they're checked
4. If any ghost re-enables are detected, confirm GHOST_REENABLE appears in audit_logs
5. Verify batch kills: trigger a run where multiple variants in one campaign are killed. Confirm single `update_campaign` call per campaign in logs.
