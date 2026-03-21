# CC Revision Spec: Step Number Indexing Consistency

**Date:** 2026-03-20
**Severity:** Medium (data confusion during audits, no functional impact on kill logic)
**Scope:** `index.ts`, `types.ts` (audit entry + notification record construction)
**CC-Review:** v2 (incorporated review findings)

## What Went Wrong

During the 6pm ET cron audit on 2026-03-19, the audit report presented step numbers to Sam for manual UI verification. The Slack notification correctly displayed "Step 3, Variant C" for the Kindred Capital campaign, but the audit table presented it as "Step 4" because the auditor applied a +1 offset to the Slack's already-1-indexed step number. Sam went to Step 4 in the Instantly UI, found only variants A and B, and flagged phantom variants C/D/E as a potential data integrity issue.

The actual data was correct. The variants existed on Step 3 (UI). The confusion arose from a mismatch between how step numbers are stored vs. displayed.

## Why It Went Wrong

The CC worker uses two different indexing conventions simultaneously:

| Location | Convention | Example |
|----------|-----------|---------|
| Instantly API response | 0-indexed | `step: "2"` |
| Internal loop variable (`stepIndex`) | 0-indexed | `stepIndex = 2` |
| `audit_logs.step` (Supabase) | 0-indexed | `step: 2` |
| `notifications.step` (Supabase) | 0-indexed | `step: 2` |
| KV log entries | 0-indexed | `step: 2` |
| Slack messages (user-facing) | **1-indexed** | `"Step 3, Variant C"` |
| Instantly UI (user-facing) | **1-indexed** | Step 3 tab |

The +1 conversion happens **only** in `slack.ts` format functions (e.g., `Step ${stepIndex + 1}`). Every database record stores the raw 0-indexed value. This means anyone querying audit_logs or notifications must mentally add +1 to match what they see in Slack and the UI.

During the audit, the path was: Slack says "Step 3" -> auditor queries Supabase and sees `step: 2` -> auditor adds +1 to "Step 3" instead of to `step: 2` -> arrives at "Step 4" -> doesn't find the variants.

## The Technical Details

### Current code path (0-indexed everywhere except Slack):

**`index.ts` line 692** (kill audit entry construction):
```typescript
const auditEntry: AuditEntry = {
  step: stepIndex,    // 0-indexed
  variant: kill.variantIndex,
  ...
};
```

**`index.ts` line 908** (warning audit entry construction):
```typescript
const warningAudit: AuditEntry = {
  step: stepIndex,    // 0-indexed
  variant: warning.variantIndex,
  ...
};
```

**`supabase.ts` line 28** (writes raw 0-indexed value):
```typescript
step: entry.step,     // 0-indexed, written as-is
variant: entry.variant,
```

**`slack.ts` lines 40-43, 68, 107, 154, 194** (all apply +1):
```typescript
`Step ${action.stepIndex + 1}, Variant ${label}`
```

### Key constraint
- `KillAction.stepIndex` MUST remain 0-indexed because it's used in API calls to Instantly (variant disable/enable target the 0-indexed step)
- The loop variable `stepIndex` MUST remain 0-indexed because it's compared against `analytics.step` from the API
- The Slack format functions receive `KillAction` or `RescanEntry` objects that use `stepIndex`

## What Needs to Be Fixed

Store **1-indexed (display) step numbers** in all Supabase tables and KV log entries. This aligns database records with what users see in Slack and the Instantly UI, eliminating the conversion step during audits.

### Changes Required

#### 1. `index.ts` — All 9 AuditEntry constructions

Every AuditEntry construction must store 1-indexed steps. There are two categories:

**Category A: Uses loop variable `stepIndex` (5 sites)**

| Line | Action | Current | Change to |
|------|--------|---------|-----------|
| ~685 | DISABLED | `step: stepIndex` | `step: stepIndex + 1` |
| ~707 | DEFERRED | inherits from DISABLED entry via spread | No change needed (inherited) |
| ~809 | BLOCKED | `step: stepIndex` | `step: stepIndex + 1` |
| ~901 | WARNING | `step: stepIndex` | `step: stepIndex + 1` |
| ~975 | BLOCKED (kills paused) | spread from pk.auditEntry | No change needed (inherited) |

Net: 3 direct changes (DISABLED, BLOCKED, WARNING). DEFERRED and kills-paused BLOCKED inherit automatically.

**Category B: Uses `entry.stepIndex` or `kill.stepIndex` from stored RescanEntry/KV data (4 sites)**

These use 0-indexed values from `RescanEntry.stepIndex` (which MUST stay 0-indexed for API calls). Each needs explicit `+ 1`:

| Line | Action | Current | Change to |
|------|--------|---------|-----------|
| ~1189 | EXPIRED | `step: entry.stepIndex` | `step: entry.stepIndex + 1` |
| ~1277 | CM_OVERRIDE | `step: entry.stepIndex` | `step: entry.stepIndex + 1` |
| ~1377 | RE_ENABLED | `step: entry.stepIndex` | `step: entry.stepIndex + 1` |
| ~1812 | GHOST_REENABLE | `step: kill.stepIndex` | `step: kill.stepIndex + 1` |

**Total: 7 direct changes across 9 construction sites.**

#### 2. `index.ts` — All 4 NotificationRecord constructions with non-null step

| Line | Notification Type | Current | Change to |
|------|------------------|---------|-----------|
| ~865 | LAST_VARIANT | `step: stepIndex` | `step: stepIndex + 1` |
| ~958 | WARNING | `step: stepIndex` | `step: stepIndex + 1` |
| ~1074 | KILL | `step: pk.stepIndex` | `step: pk.stepIndex + 1` |
| ~1360 | RESCAN_RE_ENABLED | `step: entry.stepIndex` | `step: entry.stepIndex + 1` |

Two additional NotificationRecords (LEADS_EXHAUSTED at ~1557, LEADS_WARNING at ~1651) use `step: null` and are unaffected.

**Total: 4 changes.**

#### 3. KV log key — Acknowledged change, no action needed

The `writeAuditLog` KV function (~line 65) constructs keys as:
```typescript
const key = `log:${entry.timestamp}:${entry.campaignId}:${entry.step}:${entry.variant}`;
```

After this change, `entry.step` will be 1-indexed, so log keys will shift (e.g., `log:...:2:...` becomes `log:...:3:...`). This is **acceptable** because:
- Log keys are write-only (never read for dedup or logic)
- Old log entries remain readable, just have different step convention
- No cleanup needed

#### 4. KV dedup keys — NO CHANGES (they stay 0-indexed)

The dedup keys use `stepIndex` directly from the loop variable or `entry.stepIndex` from RescanEntry, NOT from `AuditEntry.step`:

| Key pattern | Source | Stays 0-indexed |
|------------|--------|----------------|
| `kill:${campaign.id}:${stepIndex}:${variantIndex}` | Loop var | Yes |
| `blocked:${campaign.id}:${stepIndex}:${variantIndex}` | Loop var | Yes |
| `warning:${campaign.id}:${stepIndex}:${warning.variantIndex}` | Loop var | Yes |
| `rescan:${entry.campaignId}:${entry.stepIndex}:${entry.variantIndex}` | RescanEntry | Yes |

**No dedup risk.** These keys are constructed from `stepIndex` and `entry.stepIndex`, which are unaffected by this change. Old and new keys will be identical. No migration needed. No duplicate notification risk on deploy.

#### 5. `supabase.ts` — No changes needed

`writeAuditLogToSupabase` and `writeNotificationToSupabase` pass through `entry.step` and `record.step` as-is. Since we're changing the value at construction time, the write functions need no modification.

#### 6. `slack.ts` — No changes needed

Slack format functions receive `KillAction` and `RescanEntry` objects (not AuditEntry). They use `action.stepIndex` (0-indexed) with their own `+ 1` conversion. This is a completely separate code path.

#### 7. `types.ts` — Add JSDoc comment

```typescript
export interface AuditEntry {
  ...
  /** 1-indexed step number matching Instantly UI and Slack display */
  step: number;
  ...
}
```

### What NOT to change

- `KillAction.stepIndex` — stays 0-indexed (used for API calls and Slack formatting)
- `RescanEntry.stepIndex` — stays 0-indexed (used for API calls, Slack formatting, and KV dedup keys)
- Loop variable `stepIndex` — stays 0-indexed (API comparison)
- `slack.ts` format functions — keep the `+ 1` on `stepIndex` (different source object)
- `evaluator.ts` — all 0-indexed, no display concern
- KV dedup keys (`kill:`, `blocked:`, `warning:`, `rescan:`) — stay 0-indexed (separate source variable)

### Migration

No Supabase migration needed. The `step` column is already an integer. Existing v2 data has 0-indexed values, but since we never query historical step numbers for logic (only for display/audit), the inconsistency with old rows is acceptable. New rows will be 1-indexed.

Optional: one-time SQL to update existing v2 rows for consistency:
```sql
UPDATE audit_logs SET step = step + 1 WHERE worker_version = 'v2';
UPDATE notifications SET step = step + 1 WHERE worker_version = 'v2';
```

### Verification

After deploying, trigger a cron run and verify:
1. Query `audit_logs WHERE worker_version = 'v2' AND timestamp > [deploy_time]` — step values should now match Slack "Step N" numbers
2. Query `notifications` same filter — step values should match
3. Slack messages unchanged (still show correct Step N)
4. No Instantly API errors (kill/enable targeting unaffected)
5. KV dedup still works — no duplicate Slack notifications after deploy

### Risk Assessment

- **Low risk.** The change only affects what number is stored in audit/display records (AuditEntry and NotificationRecord)
- **No functional impact.** Kill logic, safety checks, and API calls all use 0-indexed `stepIndex` from separate code paths
- **No dedup risk.** KV dedup keys (`kill:`, `blocked:`, `warning:`, `rescan:`) are constructed from `stepIndex` / `entry.stepIndex`, not from `AuditEntry.step`. They remain 0-indexed and unchanged.
- **KV log keys change.** The `log:` key pattern uses `entry.step` and will shift to 1-indexed. This is cosmetic only (log keys are write-only, never read for dedup).

### Change Summary

| File | Changes |
|------|---------|
| `index.ts` | 7 AuditEntry `step:` values + 4 NotificationRecord `step:` values = **11 line changes** |
| `types.ts` | 1 JSDoc comment addition |
| `supabase.ts` | None |
| `slack.ts` | None |
| `evaluator.ts` | None |

## Execution Instructions

1. Use `/technical` persona to implement the 11 line changes enumerated above
2. Run `npx tsc --noEmit` to verify compilation
3. Run `/cc-review` before deploying — all 8 checklist items must pass
4. Deploy with `npx wrangler deploy`
5. Verify with the queries in the Verification section above
