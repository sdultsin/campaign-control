# 6pm ET Validation Audit — March 21, 2026

**Run time:** 6pm ET = 22:00 UTC
**Worker version expected:** `5e18a9b`
**Previous run:** 8am ET (12:08 UTC), version `0d78ca0` — 0 errors, 11 kills (5 bad due to date filter)
**What this run validates:**
1. **Date filter removal** (`ff07af8`) — opp counts should now match Instantly UI
2. **OFF campaign 20% buffer** (`5e18a9b`) — OFF campaigns evaluated with buffered thresholds
3. **All 4 pilot CMs receiving notifications** (Alex, Carlos, Ido, Samuel)
4. Kill cap, LAST_VARIANT, grouped notifications still healthy

---

## Part 1: Run Health (automated)

All queries use CC Supabase (project `kczjvbbpwjrgbvomdawi`). The 6pm cron fires at ~22:00 UTC.

### 1.0 Confirm run completed with correct version

```sql
SELECT worker_version, timestamp, campaigns_evaluated, variants_disabled, variants_blocked, variants_warned, errors, dry_run
FROM run_summaries
WHERE timestamp >= '2026-03-21 21:50:00+00'
ORDER BY timestamp DESC
LIMIT 1;
```

**Expected:** `worker_version = '5e18a9b'`, `errors = 0`, `dry_run = false`. If version is `ff07af8`, the OFF buffer deploy didn't take. If version is `0d78ca0`, neither deploy took.

### 1.1 Kill cap enforcement

From the same result: `variants_disabled <= 10`. The 8am run had 11 (off-by-one bug). Check if this is fixed.

### 1.2 All actions this run

```sql
SELECT action, COUNT(*) as count
FROM audit_logs
WHERE timestamp >= '2026-03-21 21:55:00+00'
  AND worker_version = '5e18a9b'
GROUP BY action
ORDER BY action;
```

**Expected:** Breakdown of DISABLED, BLOCKED, WARNING, DEFERRED actions. Report totals.

---

## Part 2: Date Filter Fix Validation (critical)

The 8am run had 5 bad kills because date-filtered `getStepAnalytics` undercounted opps. The fix (`ff07af8`) removed date params. Validate that opp counts now match the Instantly UI.

### 2.1 Pull all DISABLED variants with their opp data

```sql
SELECT campaign, cm, step, variant_label, action,
       trigger_sent, trigger_opportunities, trigger_ratio,
       safety_surviving_variants
FROM audit_logs
WHERE action = 'DISABLED'
  AND timestamp >= '2026-03-21 21:55:00+00'
  AND worker_version = '5e18a9b'
ORDER BY cm, campaign, step;
```

### 2.2 Pull WARNING variants

```sql
SELECT campaign, cm, step, variant_label,
       trigger_sent, trigger_opportunities, trigger_ratio
FROM audit_logs
WHERE action = 'WARNING'
  AND timestamp >= '2026-03-21 21:55:00+00'
  AND worker_version = '5e18a9b'
ORDER BY cm, campaign, step;
```

### 2.3 Spot-check against Instantly UI

For EACH campaign that has a DISABLED or WARNING entry, Sam needs to verify in the Instantly UI:

**Produce a Google Sheet (or table) with one row per action, columns:**

| CM | Campaign (exact name) | Workspace | Step | Variant | CC Sent | CC Opps | UI Sent | UI Opps | Match? | Should Be |
|----|----------------------|-----------|------|---------|---------|---------|---------|---------|--------|-----------|

- **CC Sent / CC Opps:** From audit_logs query above
- **UI Sent / UI Opps:** Sam fills in from Instantly UI
- **Match?:** Sam marks YES if within 1% tolerance for sent AND exact match for opps
- **Should Be:** For DISABLED variants, should be OFF. For WARNING variants, should still be ON.

**Priority campaigns to check (from the 8am failures):**
1. RG2161, RG2162, RG2163, RG2164 RG 2289- Construction — Steps 3/4/5 (worst offenders at 8am)
2. Restaurants: RG2157, RG2158, RG2159, RG2160 (IDO) — Step 1
3. Pair 1 RG59/RG60/RG61 - Construction - Summit Bridge (CARLOS) — Step 3

If these campaigns appear with DIFFERENT opp counts than 8am, that confirms the fix. If they appear with the SAME undercounted opps, the fix didn't work.

---

## Part 3: OFF Campaign 20% Buffer Validation

### 3.1 Identify OFF campaigns in this run

```sql
SELECT DISTINCT campaign, cm
FROM audit_logs
WHERE timestamp >= '2026-03-21 21:55:00+00'
  AND worker_version = '5e18a9b'
  AND campaign LIKE 'OFF%'
ORDER BY cm, campaign;
```

**Expected:** OFF-prefixed campaigns should now appear (they were excluded before `5e18a9b`).

### 3.2 Check buffered thresholds on OFF campaign actions

```sql
SELECT campaign, cm, step, variant_label, action,
       trigger_sent, trigger_opportunities, trigger_ratio,
       trigger_threshold
FROM audit_logs
WHERE timestamp >= '2026-03-21 21:55:00+00'
  AND worker_version = '5e18a9b'
  AND campaign LIKE 'OFF%'
ORDER BY campaign, step;
```

**Expected thresholds for OFF campaigns (buffered = base x 1.2):**

| Product | Infra | Normal | OFF (buffered) |
|---------|-------|--------|----------------|
| Funding | Google | 3,800 | 4,560 |
| Funding | SMTP/OTD | 4,500 | 5,400 |
| Funding | Outlook | 5,000 | 6,000 |
| Funding | Default | 4,000 | 4,800 |
| ERC | All | 6,000 | 7,200 |
| S125 | All | 14,000 | 16,800 |

Verify `trigger_threshold` matches the buffered column for each OFF campaign's product/infra combination.

### 3.3 Slack annotation check

For any OFF campaign that appears in Slack notifications, verify the thread reply includes the annotation line:
> "OFF campaign -- threshold raised 20% (base -> buffered)"

Pull from whichever CM channel has OFF campaign notifications.

---

## Part 4: Notification Coverage

### 4.1 All 4 pilot CM channels received messages

Pull messages from all 4 channels after 21:55 UTC:
- `#cc-alex` (C0AN70F328G)
- `#cc-carlos` (C0AMRK81MRP)
- `#cc-ido` (C0AMRK842PK)
- `#cc-samuel` (C0AMCMVLVDG)

**Expected:** All 4 channels should have at least one parent message. Report the notification types and counts per channel.

### 4.2 Grouped format still correct

Verify parent + thread structure (not individual top-level messages per variant).

---

## Part 5: Safety Checks

### 5.1 LAST_VARIANT protection

```sql
SELECT campaign, step, variant_label, safety_surviving_variants
FROM audit_logs
WHERE action = 'BLOCKED' AND safety_notification = 'LAST_VARIANT'
  AND timestamp >= '2026-03-21 21:55:00+00'
ORDER BY campaign, step;
```

**Expected:** Rows present. All should have `safety_surviving_variants = 0`.

### 5.2 7-day kill dedup

Check if any variant killed in the 8am run (that was then re-enabled by Sam) gets re-evaluated correctly. The 4 reversed variants should be evaluated fresh since Sam manually re-enabled them — the dedup key is based on the kill action, and re-enabling resets eligibility.

```sql
SELECT campaign, step, variant_label, action
FROM audit_logs
WHERE timestamp >= '2026-03-21 21:55:00+00'
  AND worker_version = '5e18a9b'
  AND (
    (campaign = 'RG2161, RG2162, RG2163, RG2164 RG 2289- Construction' AND step IN (3, 4))
    OR (campaign = 'Restaurants: RG2157, RG2158, RG2159, RG2160 (IDO)' AND step = 1)
    OR (campaign LIKE 'Pair 1 RG59%' AND step = 3)
  )
ORDER BY campaign, step;
```

**Expected:** These should appear in audit_logs with correct (higher) opp counts. If they show as DEFERRED with the same low opps, the fix didn't work. If they don't appear at all, they may be under dedup — investigate.

---

## Part 6: Final Report Template

```
## 6pm Validation Audit Results — March 21, 2026

**Worker version:** [confirmed]
**Run timestamp:** [UTC]
**Total kills:** X / 10 cap
**Total deferred:** X
**Total warnings:** X
**Total blocked (LAST_VARIANT):** X
**Errors:** X

### Date Filter Fix
- [ ] Opp counts match Instantly UI (within 1% sent, exact opps)
- [ ] Previously-bad campaigns (RG2161, Restaurants, Summit Bridge) now show correct opps
- [ ] No false kills from undercounted opps

### OFF Campaign Buffer
- [ ] OFF campaigns appear in audit_logs (were excluded before)
- [ ] Buffered thresholds correct (base x 1.2)
- [ ] Slack annotations present ("OFF campaign -- threshold raised 20%")

### Notification Coverage
- [ ] All 4 CM channels received messages
- [ ] Grouped format correct (parent + thread)

### Safety
- [ ] Kill cap <= 10
- [ ] LAST_VARIANT protection firing
- [ ] No errors

### Spot-Check Table (Sam fills UI columns)
[table from Part 2.3]

### Issues Found
[any problems, or "None -- all clear for steady-state"]
```

---

## If something is wrong

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| Opp counts still undercounted | Date filter fix didn't deploy | Check worker_version, redeploy ff07af8 |
| OFF campaigns not appearing | OFF buffer deploy didn't take | Check worker_version, redeploy 5e18a9b |
| OFF thresholds not buffered | `resolveThreshold` not receiving `isOff` flag | Check index.ts passes `isOffCampaign()` to `resolveThreshold()` |
| No Slack annotation on OFF kills | `slack.ts` not checking `isOff` on KillAction | Check slack.ts formatKillNotification |
| variants_disabled > 10 | Kill cap off-by-one still present | Investigate batch kill budget counting |
| Reversed variants not re-evaluated | 7-day dedup blocking | Check KV dedup keys for those variants |
| 0 messages in a CM channel | No actionable variants for that CM | Confirm by checking audit_logs for that CM |
