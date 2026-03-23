# CC 6am Run Verification - Data Accuracy Spot-Check

**Date:** 2026-03-23
**Run timestamp:** 2026-03-23 10:14:13 UTC (6:14 AM ET)
**Worker version:** `18aaf70`
**Run summary:** 17 workspaces, 63 campaigns evaluated, 10 kills, 39 blocked, 14 warned, 0 errors, 18 leads warnings, 840s duration

---

## What This Is

Manual verification that CC is pulling accurate numbers from Instantly. You open each campaign in the Instantly UI and compare sent/opps/lead counts against what CC logged in Supabase. Any discrepancy means the system is making decisions on wrong data.

## How To Run

For each campaign below:
1. Open in Instantly UI (search by campaign name in the correct workspace)
2. Go to the Analytics tab - compare **sent** and **opportunities** per step/variant
3. Go to the Leads tab - compare **total leads**, **contacted**, and **active/uncontacted**
4. Record the Instantly UI number next to CC's number
5. Flag any mismatch > 5% as a discrepancy (small timing differences are expected)

**Important:** Instantly UI shows 0-indexed steps in some views and 1-indexed in others. CC uses 1-indexed (Step 1 = first email). Variants are A=0, B=1, C=2, etc.

---

## Section 1: Step Analytics Verification (Sent / Opportunities)

These are campaigns where CC made a decision (kill or block). If the sent/opps numbers are wrong, the decision was wrong.

### Campaign 1: HealthSphere - Owners (IDO) - Section 125 1
**Campaign ID:** `4ea5a3d0-c2a8-40c3-8479-7fcd0ee0661c`
**Workspace:** Section 125 1
**Product:** S125 (threshold: 14,000)

CC recorded these DISABLED actions (kills executed):

| Step | Variant | CC Sent | CC Opps | CC Ratio | Action |
|------|---------|---------|---------|----------|--------|
| 1 | B | 58,644 | 0 | Infinity | DISABLED |
| 1 | C | 33,344 | 0 | Infinity | DISABLED |
| 2 | A | 62,484 | 0 | Infinity | DISABLED |
| 2 | B | 62,472 | 0 | Infinity | DISABLED |
| 3 | B | 20,115 | 0 | Infinity | DISABLED |
| 4 | A | 42,819 | 0 | Infinity | DISABLED |

CC also recorded these BLOCKED (would kill but last variant):

| Step | Variant | CC Sent | CC Opps | CC Ratio |
|------|---------|---------|---------|----------|
| 1 | A | 41,003 | 0 | Infinity |
| 3 | A | 76,520 | 1 | 76520:1 |

**Verify in Instantly UI:**
- [ ] Step 1: Variant A sent = _____ opps = _____ | Variant B sent = _____ opps = _____ | Variant C sent = _____ opps = _____
- [ ] Step 2: Variant A sent = _____ opps = _____ | Variant B sent = _____ opps = _____
- [ ] Step 3: Variant A sent = _____ opps = _____ | Variant B sent = _____ opps = _____
- [ ] Step 4: Variant A sent = _____ opps = _____
- [ ] Are killed variants (B, C in step 1; A, B in step 2; B in step 3; A in step 4) now showing as disabled in the campaign sequence?

### Campaign 2: Chief/VP HR/Benefits (IDO) - Section 125 1
**Campaign ID:** `c1087222-10b3-4405-8762-9427de570c34`
**Workspace:** Section 125 1
**Product:** S125 (threshold: 14,000)

DISABLED:

| Step | Variant | CC Sent | CC Opps | Action |
|------|---------|---------|---------|--------|
| 3 | A | 26,947 | 0 | DISABLED |
| 4 | A | 26,562 | 0 | DISABLED |
| 5 | B | 21,433 | 0 | DISABLED |

BLOCKED:

| Step | Variant | CC Sent | CC Opps |
|------|---------|---------|---------|
| 1 | A | 38,073 | 2 (ratio 19036:1, eff. threshold 15400) |
| 2 | A | 31,479 | 0 |
| 3 | B | 26,936 | 0 |
| 5 | A | 17,067 | 0 |

**Verify in Instantly UI:**
- [ ] Step 1 Variant A: sent = _____ opps = _____
- [ ] Step 2 Variant A: sent = _____ opps = _____
- [ ] Step 3 Variant A: sent = _____ opps = _____ | Variant B: sent = _____ opps = _____
- [ ] Step 4 Variant A: sent = _____ opps = _____
- [ ] Step 5 Variant A: sent = _____ opps = _____ | Variant B: sent = _____ opps = _____

### Campaign 3: BrightFunds - Beauty Salons (CARLOS) - The Dyad
**Campaign ID:** `7d342a18-6c96-4b6a-a884-b2ca7926db60`
**Workspace:** The Dyad
**Product:** FUNDING (threshold: 3,800 Google)

BLOCKED:

| Step | Variant | CC Sent | CC Opps | CC Ratio | Eff. Threshold |
|------|---------|---------|---------|----------|----------------|
| 1 | D | 18,061 | 4 | 4515:1 | 4,180 |
| 2 | C | 5,941 | 1 | 5941:1 | 4,180 |

**Verify in Instantly UI:**
- [ ] Step 1 Variant D: sent = _____ opps = _____
- [ ] Step 2 Variant C: sent = _____ opps = _____
- [ ] How many total variants in Step 1? _____ (CC says 0 surviving = all would be killed)

### Campaign 4: Advertising - Outlook (IDO) - Outlook 1
**Campaign ID:** `91b0259e-6513-44cc-a83a-62c74923e00f`
**Workspace:** Outlook 1
**Product:** FUNDING (threshold: 5,000 Outlook)

BLOCKED:

| Step | Variant | CC Sent | CC Opps |
|------|---------|---------|---------|
| 2 | B | 17,644 | 3 |
| 3 | B | 8,521 | 1 |
| 4 | A | 7,096 | 1 |
| 5 | A | 7,526 | 0 |

**Verify in Instantly UI:**
- [ ] Step 2 Variant B: sent = _____ opps = _____
- [ ] Step 3 Variant B: sent = _____ opps = _____
- [ ] Step 4 Variant A: sent = _____ opps = _____
- [ ] Step 5 Variant A: sent = _____ opps = _____

---

## Section 2: Leads Count Verification (Contacted / Uncontacted)

These campaigns triggered LEADS_WARNING. CC computes `active = leads_count - completed - bounced - unsubscribed` using batch analytics (lifetime accumulators). Known approximation. This check tells us how far off the approximation is.

### Campaign 5: Equivest Finance (IDO) - Renaissance 4
**Campaign ID:** `b4720269-f01b-4e2d-9485-4eba098abf3b`
**Nearly exhausted - 14 active out of 33,548 total**

| Metric | CC Value | Instantly UI |
|--------|----------|--------------|
| Total leads | 33,548 | _____ |
| Completed | 33,493 | _____ |
| Active (uncontacted) | 14 | _____ |
| Bounced | 3 | _____ |
| Unsubscribed | 1 | _____ |

### Campaign 6: Law Firms - Equivest Finance (IDO) - Renaissance 4
**Campaign ID:** `025ff8f0-bed7-4073-aae3-040a089ec40d`
**Low active - 3,618 out of 26,813**

| Metric | CC Value | Instantly UI |
|--------|----------|--------------|
| Total leads | 26,813 | _____ |
| Completed | 23,068 | _____ |
| Active (uncontacted) | 3,618 | _____ |
| Bounced | 16 | _____ |
| Unsubscribed | 2 | _____ |

### Campaign 7: ON - PAIR 3 - General (Alex) - Renaissance 5
**Campaign ID:** `bb853bcf-e78e-45e7-b846-819aefe5856a`
**Mid-range - 18,379 active out of 25,879**

| Metric | CC Value | Instantly UI |
|--------|----------|--------------|
| Total leads | 25,879 | _____ |
| Completed | 7,146 | _____ |
| Active (uncontacted) | 18,379 | _____ |
| Bounced | 353 | _____ |
| Unsubscribed | 1 | _____ |

### Campaign 8: ON - Pair 2 - RESTAURANTS (SAMUEL) - The Eagles
**Campaign ID:** `e4817218-439d-4ea4-9c9f-0298f8d96dae`
**Mid-range - 22,600 active out of 29,202**

| Metric | CC Value | Instantly UI |
|--------|----------|--------------|
| Total leads | 29,202 | _____ |
| Completed | 6,523 | _____ |
| Active (uncontacted) | 22,600 | _____ |
| Bounced | 73 | _____ |
| Unsubscribed | 0 | _____ |

---

## Section 3: Threshold Logic Verification

For each campaign above, verify the threshold CC applied was correct:

| Campaign | Workspace | Product | Expected Threshold | CC Applied | Has Opps? | Eff. Threshold | OFF? | Correct? |
|----------|-----------|---------|-------------------|------------|-----------|----------------|------|----------|
| HealthSphere | Section 125 1 | S125 | 14,000 | 14,000 | No (most) | 14,000 | No | [ ] |
| Chief/VP HR | Section 125 1 | S125 | 14,000 | 14,000 | Some | 15,400 | No | [ ] |
| BrightFunds Beauty | The Dyad | FUNDING | 3,800 (Google) | 3,800 | Yes | 4,180 | No | [ ] |
| Advertising Outlook | Outlook 1 | FUNDING | 5,000 (Outlook) | 5,000 | Some | 5,500 | No | [ ] |

Check: Is The Dyad actually Google? Verify provider type in Instantly account settings.

---

## Recording Results

Fill out the tables above, then summarize:

**Step Analytics:**
- Total checks: ___
- Exact matches (within 1%): ___
- Minor discrepancies (1-5%): ___
- Major discrepancies (>5%): ___
- Details on any major discrepancy: ___

**Leads Counts:**
- Total checks: ___
- Exact matches (within 1%): ___
- Minor discrepancies (1-5%): ___
- Major discrepancies (>5%): ___
- Details on any major discrepancy: ___

**Threshold Logic:**
- All correct? ___
- Any provider type mismatches? ___

**Overall Verdict:**
- [ ] CC data is accurate - decisions are sound
- [ ] Minor issues found - document but not urgent
- [ ] Major issues found - CC is making decisions on bad data, needs fix before next run

---

## Execution Instructions

1. This is a **manual verification** - open Instantly UI in browser
2. Work through Sections 1-3 in order
3. Fill in the blank cells with values from the Instantly UI
4. Note any discrepancies in the Recording Results section
5. Save completed audit as `specs/2026-03-23-6am-verification-results.md`
6. If major discrepancies found, flag Sam immediately - may need to pause CC cron
