# Auto Turn-Off Variants: Phase 0 Test Results

**Date:** [2026-03-15]
**Test environment:** Sam's personal Instantly workspace ("Sam Dultsin")
**API key location:** `.env.personal` (NOT committed)

---

## What We Validated

### 1. Variant toggle via API — CONFIRMED

**Field:** `v_disabled` (boolean) on each variant object within `sequences[].steps[].variants[]`

**How it works:**
- `v_disabled: true` = variant toggled OFF (same as UI toggle)
- `v_disabled: false` or field absent = variant ON (default)
- Variants are NOT deleted. They retain historical data and can be re-enabled.

**Endpoint:** `PATCH /api/v2/campaigns/{campaign_id}`

**Request body structure:**
```json
{
  "sequences": [
    {
      "steps": [
        {
          "type": "email",
          "delay": 2,
          "delay_unit": "days",
          "pre_delay_unit": "days",
          "variants": [
            { "subject": "...", "body": "...", "v_disabled": false },
            { "subject": "...", "body": "...", "v_disabled": true }
          ]
        }
      ]
    }
  ]
}
```

**Critical:** The PATCH replaces the entire `sequences` array. You MUST send ALL steps and ALL variants in the payload, not just the one you're modifying. Sending a partial sequences array will overwrite/delete the missing steps and variants.

**Auth:** `Authorization: Bearer {api_key}` header.

**Verification:** After PATCH, a fresh `GET /api/v2/campaigns/{campaign_id}` returns `v_disabled: true` on disabled variants. The field is omitted (defaults false) on enabled variants.

### 2. Per-variant analytics — CONFIRMED

**Endpoint:** `GET /api/v2/campaigns/analytics/steps?campaign_id={id}&include_opportunities_count=true`

**Response:** Array of objects, one per step+variant combination:
```json
{
  "step": "0",
  "variant": "0",
  "sent": 26,
  "opened": 0,
  "unique_opened": 0,
  "replies": 2,
  "unique_replies": 2,
  "replies_automatic": 3,
  "unique_replies_automatic": 3,
  "clicks": 0,
  "unique_clicks": 0,
  "opportunities": 1,
  "unique_opportunities": 1
}
```

**Key details:**
- Steps and variants are 0-indexed (step 0 = Step 1 in UI, variant 0 = A, 1 = B, etc.)
- Opportunities only appear when `include_opportunities_count=true` is passed as query param
- Without the param, only sent/replies/clicks are returned
- Data persists even after variants are disabled

### 3. Decision logic end-to-end — CONFIRMED

Ran full 5-phase evaluation on Template D campaign:

**Phase 1 - Read:** Pulled per-variant analytics via API
**Phase 2 - Decide:** Applied gate + ratio logic (adapted thresholds for small scale)
**Phase 3 - Safety:** Verified surviving variants > 0 before proceeding
**Phase 4 - Execute:** Set `v_disabled: true` on kill candidate via PATCH
**Phase 5 - Verify:** Fresh GET confirmed correct state

Test results on Template D:
| Variant | Sent | Opps | Ratio | Decision | Reason |
|---------|------|------|-------|----------|--------|
| A (0) | 26 | 1 | 26:1 | KEEP | Under threshold |
| B (1) | 27 | 0 | N/A | TURN OFF | 0 opps past gate |
| C (2) | 1,197 | 3 | 399:1 | KEEP | Under threshold |
| D (3) | 24 | 0 | N/A | SKIP | Below minimum sends gate |

All three decision paths exercised: KEEP, TURN OFF, and SKIP.

---

## What We Learned the Hard Way

### PATCH replaces entire sequences array
When we first tested with a partial payload (2 variants, dummy body text), it overwrote the campaign from 4 steps/7 variants down to 1 step/2 variants. The original body content was lost from the analytics linkage for campaign D-1. **Always GET the full campaign first, modify in-place, then PATCH back.**

### Field name is `v_disabled`, not `disabled` or `active`
First attempt used `disabled: true` — silently accepted by the API but ignored. Perplexity search of [developer.instantly.ai/api-reference/schemas/campaign](https://developer.instantly.ai/api-reference/schemas/campaign) revealed the correct field name.

### Renaissance MCP uses a different API key
The Instantly MCP (King MCP) is connected to Renaissance's org. Sam's personal workspace requires direct API calls with his personal key. For the actual build, we'll use the Renaissance API key (via MCP or direct calls).

---

## What Remains (Phase 1: Build MVP)

### Must build
1. **Polling loop** — iterate all workspaces, all campaigns, all steps, all variants per hourly run
2. **Cron/scheduler** — AWS Lambda + EventBridge or Cloudflare Workers (decision pending)
3. **Slack notifications** — two types: "can't kill" (last variant) and "killed down to 1" (deliverability risk)
4. **CM name parser** — extract from campaign naming convention `[Tag] [Brand] [Industry] [CM Name]`
5. **Dry-run mode** — log what WOULD be killed without actually disabling, for initial validation

### Must check later
- **Rate limits** — hundreds of API calls per hour across 22 workspaces. Throttle if needed. Ask Outreachify/Instantly CTO contact.
- **Opportunity data lag** — if IMs mark opportunities late, a variant could be killed despite having unreported opps. Monitor during pilot.

### Deferred to v2
- Per-infrastructure thresholds (Google 3.8K, OTD 4.5K, Outlook 5K) — requires Google Sheets MCP
- ERC thresholds (6,000/opp) and S125 thresholds (14,000/opp)
- Warm leads workspace exclusion logic

### Architecture decisions still open
- **Hosting:** AWS Lambda + EventBridge vs Cloudflare Workers
- **Language:** Python (matches test scripts) vs JavaScript (matches Cloudflare Workers)
- **API key management:** Direct API calls vs routing through King MCP

---

## API Reference (Quick)

| Action | Method | Endpoint | Key Params |
|--------|--------|----------|------------|
| List campaigns | GET | `/api/v2/campaigns?limit=50` | — |
| Get campaign detail | GET | `/api/v2/campaigns/{id}` | — |
| Update campaign | PATCH | `/api/v2/campaigns/{id}` | `sequences` (full array) |
| Step/variant analytics | GET | `/api/v2/campaigns/analytics/steps` | `campaign_id`, `include_opportunities_count=true` |
| Campaign-level analytics | GET | `/api/v2/campaigns/analytics` | `campaign_id` (optional) |
| List leads | POST | `/api/v2/leads/list` | `campaign_id`, `limit` |

All endpoints use `Authorization: Bearer {api_key}` header.

---

## Source References

- [Vision doc](vision.md) — full system design (Post-Scrutiny v2)
- [Instantly API schema](https://developer.instantly.ai/api-reference/schemas/campaign) — `v_disabled` field documentation
- Test campaign: Template D (`0e83d7cd-e0f3-43df-8179-b08feb086b6a`)
- Test workspace: Sam Dultsin (personal Instantly account)
