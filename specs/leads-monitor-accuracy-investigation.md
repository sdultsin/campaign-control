# Leads Monitor Accuracy Investigation

**Date:** 2026-03-20
**Priority:** MEDIUM
**Codebase:** `builds/auto-turn-off/src/`

---

## Problem

The "Leads Running Low" and "Leads Exhausted" notifications from CC have not been verified against the Instantly UI. Given the send count inflation issue on step analytics, the leads monitoring data may also have accuracy problems.

### Notifications to verify (7pm run)

**Leads Running Low (Ido, Renaissance 1):**

| Campaign | CC: Uncontacted | CC: Total | CC: Daily Limit |
|----------|----------------|-----------|-----------------|
| New campaign 4 | 22,483 | 71,538 | 27,000 |
| New campaign 3 | 20,624 | 92,624 | 24,000 |

**Prior "Leads Exhausted" notifications (earlier runs):**

| CM | Campaign | Run |
|----|----------|-----|
| Carlos | (2 campaigns) | Mar 20 ~10am UTC |
| Alex | (1 campaign) | Mar 19 ~10am UTC |
| Ido | (7 campaigns) | Mar 19 ~10am UTC |
| Samuel | (1 campaign) | Mar 19 ~10am UTC |

---

## Investigation Steps

### Step 1: Understand the leads monitoring logic

Read `src/leads-monitor.ts`:
- How are lead counts computed? (`computeStep0Sent()`, `evaluateLeads()`)
- What API calls does it make? (`count_leads`, `list_leads`, `get_campaign_details`?)
- What triggers "Leads Running Low" vs "Leads Exhausted"?
- How is "daily limit" calculated?

### Step 2: Verify "Leads Running Low" against Instantly

For the two flagged campaigns (New campaign 4, New campaign 3) in Renaissance 1:

Use Instantly MCP to pull:
```
count_leads(campaign_id, status="not_yet_contacted")
count_leads(campaign_id)  # total
get_campaign_details(campaign_id)  # for daily sending limit
```

Compare against CC's reported values:
- New campaign 4: CC says 22,483 / 71,538 uncontacted, daily limit 27,000
- New campaign 3: CC says 20,624 / 92,624 uncontacted, daily limit 24,000

### Step 3: Verify "Leads Exhausted" for a sample

Pick 2 of the Leads Exhausted campaigns (thread replies contain details). Pull from Slack:
- `#cc-carlos` thread at ts `1774001576.352049` (Mar 20 10:12 UTC)
- `#cc-ido` check for Leads Exhausted threads

Pull the same campaign's lead counts from Instantly. A "Leads Exhausted" campaign should have 0 or near-0 uncontacted leads.

### Step 4: Check the "daily limit" calculation

The daily limit determines the "running low" threshold (if leads < N days * daily_limit). Verify:
- Is daily limit based on the campaign's actual sending capacity (accounts * daily send per account)?
- Or is it a static config value?
- Is it accurate for the campaigns tested?

### Step 5: Check for false negatives

Are there any campaigns that SHOULD have triggered "Leads Running Low" but didn't? This is harder to test exhaustively, but spot-check 2-3 campaigns that weren't flagged by pulling their lead counts.

---

## Execution Instructions

1. `/technical` to load codebase context
2. Read `src/leads-monitor.ts` and `src/index.ts` (Phase 3: leads section)
3. Run Instantly MCP queries per Steps 2-3
4. Pull Slack thread details for Leads Exhausted notifications per Step 3
5. Document all comparisons in a findings table
6. If inaccuracies found, trace to root cause and fix
7. `tsc --noEmit` if code changes
8. `/cc-review` if code changes
9. Write handoff doc

---

## Supabase Reference

CC Supabase project: `kczjvbbpwjrgbvomdawi`

Check notifications table for leads-related entries:
```sql
SELECT campaign_name, notification_type, details, timestamp
FROM notifications
WHERE notification_type IN ('leads_exhausted', 'leads_running_low', 'leads_low')
  AND timestamp >= '2026-03-20 00:00:00+00'
ORDER BY timestamp DESC;
```

---

## Success Criteria

- [ ] "Leads Running Low" counts verified against Instantly for both campaigns
- [ ] "Leads Exhausted" verified for at least 2 sample campaigns
- [ ] Daily limit calculation understood and verified
- [ ] Any discrepancies documented with root cause
- [ ] If inaccurate: fix deployed. If accurate: documented as confirmed.
