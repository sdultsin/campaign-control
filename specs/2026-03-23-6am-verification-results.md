# CC 6am Run Verification Results - 2026-03-23

**Verified by:** Claude (automated via Instantly MCP API)
**Verification timestamp:** 2026-03-23
**Run under review:** 2026-03-23 10:14:13 UTC (6:14 AM ET), worker version `18aaf70`

---

## Section 1: Step Analytics Verification (Sent / Opportunities)

### Campaign 1: HealthSphere - Owners (IDO) - Section 125 1

| Step | Variant | CC Sent | Instantly Sent | CC Opps | Instantly Opps | Match |
|------|---------|---------|----------------|---------|----------------|-------|
| 1 | A (blocked) | 41,003 | 41,003 | 0 | 0 | EXACT |
| 1 | B (killed) | 58,644 | 58,644 | 0 | 0 | EXACT |
| 1 | C (killed) | 33,344 | 33,344 | 0 | 0 | EXACT |
| 2 | A (killed) | 62,484 | 62,484 | 0 | 0 | EXACT |
| 2 | B (killed) | 62,472 | 62,472 | 0 | 0 | EXACT |
| 3 | A (blocked) | 76,520 | 76,520 | 1 | 1 | EXACT |
| 3 | B (killed) | 20,115 | 20,115 | 0 | 0 | EXACT |
| 4 | A (killed) | 42,819 | 42,819 | 0 | 0 | EXACT |

**Result: 8/8 exact matches**

Disabled variant verification (from campaign details API):
- Step 1B: `v_disabled: true` confirmed
- Step 1C: `v_disabled: true` confirmed
- Step 2A: `v_disabled: true` confirmed
- Step 2B: `v_disabled: true` confirmed
- Step 3B: `v_disabled: true` confirmed
- Step 4A: `v_disabled: true` confirmed
- All 6 killed variants confirmed disabled in the live sequence.

### Campaign 2: Chief/VP HR/Benefits (IDO) - Section 125 1

| Step | Variant | CC Sent | Instantly Sent | CC Opps | Instantly Opps | Match |
|------|---------|---------|----------------|---------|----------------|-------|
| 1 | A (blocked) | 38,073 | 38,073 | 2 | 2 | EXACT |
| 2 | A (blocked) | 31,479 | 31,479 | 0 | 0 | EXACT |
| 3 | A (killed) | 26,947 | 26,947 | 0 | 0 | EXACT |
| 3 | B (blocked) | 26,936 | 26,936 | 0 | 0 | EXACT |
| 4 | A (killed) | 26,562 | 26,562 | 0 | 0 | EXACT |
| 5 | A (blocked) | 17,067 | 17,067 | 0 | 0 | EXACT |
| 5 | B (killed) | 21,433 | 21,433 | 0 | 0 | EXACT |

**Result: 7/7 exact matches** (Note: CC also logged Step 1B blocked at sent=10,470 opps=0 per the run, but it was already below the display threshold in the spec check.)

Disabled variant verification:
- Step 1B: `v_disabled: true` (pre-existing or prior run)
- Step 1C: `v_disabled: true` (pre-existing or prior run)
- Step 3A: `v_disabled: true` confirmed
- Step 4A: `v_disabled: true` confirmed
- Step 5B: `v_disabled: true` confirmed
- All 3 CC-killed variants confirmed disabled in the live sequence.

### Campaign 3: BrightFunds - Beauty Salons (CARLOS) - The Dyad

| Step | Variant | CC Sent | Instantly Sent | CC Opps | Instantly Opps | Match |
|------|---------|---------|----------------|---------|----------------|-------|
| 1 | D (blocked) | 18,061 | 18,061 | 4 | 4 | EXACT |
| 2 | C (blocked) | 5,941 | 5,941 | 1 | 1 | EXACT |

**Result: 2/2 exact matches**

Step 1 total variants in Instantly: At least 2 visible (A with 0 sent, D with 18,061 sent). Variants B and C likely existed but were disabled in prior runs. CC's assessment "0 surviving = all would be killed" is correct - D is the only active variant and it's blocked (last variant protection).

### Campaign 4: Advertising - Outlook (IDO) - Outlook 1

| Step | Variant | CC Sent | Instantly Sent | CC Opps | Instantly Opps | Match |
|------|---------|---------|----------------|---------|----------------|-------|
| 2 | B (blocked) | 17,644 | 17,644 | 3 | 3 | EXACT |
| 3 | B (blocked) | 8,521 | 8,521 | 1 | 1 | EXACT |
| 4 | A (blocked) | 7,096 | 7,096 | 1 | 1 | EXACT |
| 5 | A (blocked) | 7,526 | 7,526 | 0 | 0 | EXACT |

**Result: 4/4 exact matches**

### Step Analytics Summary

- **Total checks: 21**
- **Exact matches: 21 (100%)**
- **Minor discrepancies (1-5%): 0**
- **Major discrepancies (>5%): 0**

---

## Section 2: Leads Count Verification

### Campaign 5: Equivest Finance (IDO) - Renaissance 4

| Metric | CC Value | Instantly Value | Match |
|--------|----------|-----------------|-------|
| Total leads | 33,548 | 33,548 | EXACT |
| Completed | 33,493 | 33,493 | EXACT |
| Active | 14 | 14 | EXACT |
| Bounced | 3 | 3 | EXACT |
| Unsubscribed | 1 | 1 | EXACT |

Note: Instantly also reports `skipped: 37` (not tracked by CC). Formula check: 33,548 - 33,493 - 3 - 1 = 51, but active = 14. CC correctly reads real-time active count rather than computing via formula.

### Campaign 6: Law Firms - Equivest Finance (IDO) - Renaissance 4

| Metric | CC Value | Instantly Value | Match |
|--------|----------|-----------------|-------|
| Total leads | 26,813 | 26,813 | EXACT |
| Completed | 23,068 | 23,068 | EXACT |
| Active | 3,618 | 3,618 | EXACT |
| Bounced | 16 | 16 | EXACT |
| Unsubscribed | 2 | 2 | EXACT |

Note: Instantly also reports `skipped: 109`.

### Campaign 7: ON - PAIR 3 - General (Alex) - Renaissance 5

| Metric | CC Value | Instantly Value | Match |
|--------|----------|-----------------|-------|
| Total leads | 25,879 | 25,879 | EXACT |
| Completed | 7,146 | **116** | **MAJOR DISCREPANCY (60x)** |
| Active | 18,379 | **25,409** | **MAJOR DISCREPANCY (38% off)** |
| Bounced | 353 | 353 | EXACT |
| Unsubscribed | 1 | 1 | EXACT |

**INVESTIGATION:**
- CC's active (18,379) matches the formula: 25,879 - 7,146 - 353 - 1 = 18,379. This means CC is computing active via `total - completed - bounced - unsubscribed` for this campaign.
- But for Campaigns 5, 6, and 8, CC's active count matches Instantly's real-time `active` field directly (NOT the formula).
- CC's "completed" of 7,146 does NOT match Instantly's real-time completed count of 116. CC appears to be pulling this from a different data source (possibly batch analytics accumulators, which count cumulative step completions rather than leads that finished the entire sequence).
- **Impact:** CC thinks 18,379 leads remain. Instantly says 25,409 remain. CC is UNDERESTIMATING available leads by ~7,000 (28%). This makes CC's leads warning trigger earlier than necessary - a conservative (safe) direction but inaccurate.
- **Root cause hypothesis:** Different data source for "completed" count on this campaign vs the other three. Possible race condition or API inconsistency in how Renaissance 5 workspace reports lead status.

### Campaign 8: ON - Pair 2 - RESTAURANTS (SAMUEL) - The Eagles

| Metric | CC Value | Instantly Value | Match |
|--------|----------|-----------------|-------|
| Total leads | 29,202 | 29,202 | EXACT |
| Completed | 6,523 | 6,523 | EXACT |
| Active | 22,600 | 22,600 | EXACT |
| Bounced | 73 | 73 | EXACT |
| Unsubscribed | 0 | 0 | EXACT |

Note: Instantly also reports `skipped: 6`.

### Leads Count Summary

- **Total checks: 20 individual metrics**
- **Exact matches: 18 (90%)**
- **Minor discrepancies (1-5%): 0**
- **Major discrepancies (>5%): 2 (both in Campaign 7 - completed and active)**

---

## Section 3: Threshold Logic Verification

| Campaign | Workspace | Product | Expected Threshold | CC Applied | Has Opps? | Eff. Threshold | OFF? | Correct? |
|----------|-----------|---------|-------------------|------------|-----------|----------------|------|----------|
| HealthSphere | Section 125 1 | S125 | 14,000 | 14,000 | No (most) | 14,000 | No | YES |
| Chief/VP HR | Section 125 1 | S125 | 14,000 | 14,000 | Some | 15,400 (1.1x) | No | YES |
| BrightFunds Beauty | The Dyad | FUNDING | 3,800 (Google) | 3,800 | Yes | 4,180 (1.1x) | No | YES |
| Advertising Outlook | Outlook 1 | FUNDING | 5,000 (Outlook) | 5,000 | Some | 5,500 (1.1x) | No | YES |

- The Dyad: workspace name is not "Outlook", consistent with Google provider. Threshold of 3,800 matches Google FUNDING standard.
- Outlook 1: workspace name confirms Outlook provider. Threshold of 5,000 matches Outlook FUNDING standard.
- 10% opportunity buffer (effective threshold) applied correctly in all cases where opps > 0.
- **All thresholds correct.**

---

## Recording Results

**Step Analytics:**
- Total checks: 21
- Exact matches (within 1%): 21
- Minor discrepancies (1-5%): 0
- Major discrepancies (>5%): 0

**Leads Counts:**
- Total checks: 20
- Exact matches (within 1%): 18
- Minor discrepancies (1-5%): 0
- Major discrepancies (>5%): 2 (Campaign 7: completed 60x off, active 38% off)

**Threshold Logic:**
- All correct? YES (4/4)
- Any provider type mismatches? NO

---

## Overall Verdict

- [ ] CC data is accurate - decisions are sound
- [x] **Minor issues found - document but not urgent**
- [ ] Major issues found - CC is making decisions on bad data, needs fix before next run

**Rationale:** Step analytics (the data CC uses for kill/block decisions) is 100% accurate across all 21 checks. This is the critical data path. The leads count discrepancy in Campaign 7 affects only the LEADS_WARNING feature, not kill/block decisions. The error direction is conservative (CC underestimates remaining leads, triggering warnings earlier than necessary). This should be investigated but does not warrant pausing CC.

**Action items:**
1. **Investigate Campaign 7 leads data source** - Why does CC see completed=7,146 when Instantly reports completed=116? Check if CC is pulling from batch analytics vs count_leads endpoint for this campaign. May be a workspace-specific issue (Renaissance 5).
2. **Verify data source consistency** - Campaigns 5, 6, 8 show exact real-time matches. Campaign 7 appears to use formula-based computation. Check CC code for any branching in how leads data is fetched.
3. **No immediate action needed on kill/block logic** - All step analytics data is accurate and all threshold logic is correct.
