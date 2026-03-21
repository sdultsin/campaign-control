# Samuel Routing Investigation

**Date:** 2026-03-20
**Priority:** MEDIUM
**Codebase:** `builds/auto-turn-off/src/`

---

## Problem

Samuel received zero notifications from the 7pm run (and the 12pm and 6am runs on March 20). His channel `#cc-samuel` (C0AMCMVLVDG) has had no new messages since a single "Leads Exhausted" on March 19 at 10:11 UTC.

This could be:
1. **Correct** — all his campaigns are healthy (below thresholds)
2. **Routing bug** — his campaigns exist but aren't routing to his channel
3. **Parsing bug** — his campaigns don't contain "SAMUEL" in the name and get routed elsewhere
4. **Scope bug** — his campaigns are in workspaces not included in the pilot

---

## Investigation Steps

### Step 1: Find Samuel's campaigns

Read `src/config.ts` to find:
- Which workspaces are in the pilot scope?
- How are CMs parsed from campaign names? (look at `router.ts` for `resolveCmName()`)
- What pattern does it match for "Samuel"?

### Step 2: List Samuel's actual campaigns

Use Instantly MCP to list campaigns across pilot workspaces. For each workspace in the pilot config:
```
get_campaigns (workspace_id)
```

Filter for campaigns containing "SAMUEL" (case-insensitive) in the name. Also check for "Samuel" and "Sam" (could be a name collision with Sam Dultsin).

### Step 3: Evaluate Samuel's campaigns

For any Samuel campaigns found, pull their step analytics and check:
- Are any variants above the 3,800:1 ratio threshold?
- Are any 0-opp variants past the send threshold?
- Are any approaching threshold (>80%)?

If all are healthy, the silence is correct.

### Step 4: Check if Samuel campaigns routed to cc-general

Query Supabase for any audit log entries for Samuel:
```sql
SELECT DISTINCT campaign, cm, timestamp, action
FROM audit_logs
WHERE cm ILIKE '%samuel%'
ORDER BY timestamp DESC
LIMIT 20;
```

Also check the notifications table:
```sql
SELECT DISTINCT campaign_name, channel_id, notification_type, timestamp
FROM notifications
WHERE cm ILIKE '%samuel%'
ORDER BY timestamp DESC
LIMIT 20;
```

If `channel_id` doesn't match `C0AMCMVLVDG`, there's a routing issue.

### Step 5: Check cc-general for misrouted Samuel notifications

Query notifications that went to cc-general (C0AMRK8RC4R) and check if any belong to Samuel's campaigns:
```sql
SELECT campaign_name, cm, notification_type, timestamp
FROM notifications
WHERE channel_id = 'C0AMRK8RC4R'
  AND timestamp >= '2026-03-20 00:00:00+00'
ORDER BY timestamp DESC;
```

---

## Execution Instructions

1. `/technical` to load codebase context
2. Read `src/config.ts` and `src/router.ts`
3. Run Instantly MCP queries to find Samuel's campaigns
4. Run SQL queries against CC Supabase (project `kczjvbbpwjrgbvomdawi`)
5. Document findings
6. If routing bug found, fix and run `tsc --noEmit`
7. `/cc-review` if code changes
8. Write handoff doc with findings

---

## Success Criteria

- [ ] All of Samuel's campaigns identified across pilot workspaces
- [ ] Each campaign's health status documented (healthy / should-have-triggered)
- [ ] Routing path verified (campaign name -> CM parse -> channel)
- [ ] If silence is correct: documented with evidence
- [ ] If routing bug: fixed and verified
