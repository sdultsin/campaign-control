# Tag UUID Mapping Test Results

[2026-03-15] Research into bridging Instantly campaign `email_tag_list` UUIDs to Inbox Hub tag names and Email Provider.

---

## Key Finding: Two Separate Tag Systems in Instantly

Instantly has **two independent tag systems** that share the same `tag_ids` filter on `list_accounts` but are stored separately:

### 1. Custom Tags (visible via `list_tags` API)

These are organizational tags created manually in the Instantly UI or API. They categorize campaigns/accounts by **vertical or batch**.

**Renaissance 1 examples:**
| Tag UUID | Label |
|----------|-------|
| `41294bb4-dce1-4822-9ce4-6f039e3bb772` | Contractor |
| `4ec46ca8-72b4-4a38-be58-ffddef53d16a` | Hotels/Hospitality |
| `f3b3919e-dbbb-455f-ad99-4eb27f739459` | Solar |

**Equinox examples:**
| Tag UUID | Label |
|----------|-------|
| `52c610b6-d5b8-44e0-842d-2909bbac0862` | Pair 16 |
| `7b9dd66f-26bc-4fdd-8ebf-b9fe15cadd1d` | Veterinarian |
| `bb4e9aa2-731c-447a-947c-e478ae2a5241` | RG3830-3839 |

These tags appear in `list_tag_mappings` with `resource_type: 1` (account email) or `resource_type: 2` (campaign UUID).

### 2. Email Tags (NOT visible via `list_tags` API)

These are the UUIDs found in a campaign's `email_tag_list` field. They control **which sending accounts a campaign uses**. They are NOT returned by `list_tags`, but they ARE filterable via `list_accounts(tag_ids=...)`.

---

## Proof: email_tag_list UUID Resolution

### Test Campaign: "Home Improvement - RG944..." (Renaissance 1)

Campaign `f68ca28a-a41f-4ea8-b6eb-b7db4df1b6f3` has 8 UUIDs in `email_tag_list`. Each groups accounts by **domain**:

| email_tag_list UUID | Sample Accounts (domain) |
|---------------------|-------------------------|
| `ce428890-b672-42b1-a2a9-07f45640be2a` | `rangeusasync.info` |
| `9fa1e7e5-e078-4e1b-82c0-52620d49fd21` | `usanorthrange.info` |
| `b64b1d54-03b0-4124-ae14-6a25310610d0` | `usarangebase.info` |
| `e5151150-be01-424c-a9be-dc5e50fd6b2d` | `liftrangeusa.info` |
| `00728a4b-523e-46a4-b822-65afdef702de` | `leadusarange.info` |
| `1b20b57b-8108-461e-9ff3-e77e2d81d8c4` | `rangeprimeusa.info` |
| `c3dc43d2-9176-4570-b960-95c0441a5bf0` | `angelsusarange.info`, `rangeusasummit.info` |
| `1e364430-1281-4186-8270-cbbf67513cec` | `usasummitrange.info` |

**None** of these UUIDs appear in `list_tags` results for Renaissance 1.

### Test Campaign: "Helene Wells - GBC Opps" (Equinox)

Campaign `b3bf1e5a-5d4e-4b28-ae70-a08a04d61c49` has 6 UUIDs in `email_tag_list`:

| email_tag_list UUID | Accounts Returned | Persona(s) |
|---------------------|-------------------|------------|
| `8f8ac55a-26d5-42c8-921e-5aa999d39346` | `helene@renacademycogo.org`, `helene.wells@gorenacademyco.org`, etc. | **Helene Wells** (single persona) |
| `7dd79f36-1ed8-4976-81dc-0c09b74cb004` | `n.davis@fluxigrowth.co`, `joanna.buck@fluxwith.co` | Nicole Davis, Joanna Buck (mixed) |
| `bb0f24a6-f4fd-4f1c-a394-62f62b520c7c` | `carroll.gina@inputtrace.co`, `frances.duke@switchrise.co` | Gina Carroll, Frances Duke (mixed) |
| `eaf16516-c637-4697-a3d1-5fa17e718d64` | `margaret.richard@advisorylab.co`, `sawyer.jay@advisorynow.co` | Margaret Richard, Jay Sawyer (mixed) |
| `4b19e729-5c7a-4002-8394-2b2a5b4149fb` | `i.robertson@clarityformfocus.co`, `ryan.french@clarityguidelane.co` | Isabel Robertson, Ryan French, Henry Weaver (mixed) |
| `09a3c9a0-42c4-464f-b4f1-37d9c4e2bc2c` | `n.cunningham@hqfluxrenais.xyz` | Neil Cunningham |

### Test Campaign: "Ramsey, Helene, Clara - Affinity" (Equinox)

Campaign `b38fe299-f993-4238-a5e7-9085bebe220c` has only 1 UUID:

| email_tag_list UUID | Accounts Returned | Persona(s) |
|---------------------|-------------------|------------|
| `9312da28-a399-4f26-8162-39109800336c` | `truman.ellis@renadvisecotry.org`, `ramsey.hoyts@gorenaissancehq.org` | Truman Ellis, Ramsey Hoyt (mixed) |

---

## Critical Discovery: email_tag_list != Inbox Hub Tag (1:1)

The Inbox Hub "Tag" column has one row per persona (e.g., "Helene Wells", "Truman Ellis", "Ramsey Hoyt" are separate rows). But `email_tag_list` UUIDs sometimes group **multiple personas under one UUID**.

This means the mapping is:

```
email_tag_list UUID -> N accounts -> M distinct personas -> M rows in Inbox Hub
```

**Not** a clean 1:1 UUID-to-tag-name mapping.

### Why This Happens

In Renaissance 1 (Ido's workspace), each UUID maps to accounts sharing a **single domain** (e.g., all `rangeusasync.info` accounts). Each domain has multiple persona names but they're grouped by domain, not by persona.

In Equinox (Leo's workspace), some UUIDs map to a single persona ("Helene Wells"), while others group 2-3 personas together. This appears to correlate with **Pair** groupings from the Inbox Hub (column L).

---

## The Mapping Chain

### What Works

```
Campaign -> email_tag_list (UUIDs)
   -> list_accounts(tag_ids=UUID) -> accounts with first_name/last_name
      -> match against Inbox Hub Tag column (persona name)
         -> get Email Provider (column U), Workspace, CM, Status, etc.
```

### What's Missing

There is **no API endpoint** that directly maps an `email_tag_list` UUID to a human-readable tag name. The `list_tags` endpoint returns a completely different set of tags (verticals/batches), not the email-assignment tags.

### Viable Workaround

To resolve a UUID to Inbox Hub data:

1. Call `list_accounts(workspace_id, tag_ids=UUID, limit=1)` to get one sample account
2. Extract `first_name + " " + last_name` from the account
3. Look up that name in the Inbox Hub sheet's Tag column
4. Read Email Provider, CM, Status, Workspace from that row

**Caveat:** When a UUID groups multiple personas, the first account returned gives you ONE persona. You'd need to fetch more accounts and deduplicate by `first_name + last_name` to find all personas under that UUID.

---

## For the Auto-Turn-Off System

### Implication

The auto-turn-off system needs to know which sending accounts (and their Email Provider) a campaign uses. The chain is viable but indirect:

1. **From campaign:** Get `email_tag_list` UUIDs and `workspace_id`
2. **From each UUID:** `list_accounts(tag_ids=UUID)` to get all account emails
3. **From account email:** Look up in Inbox Hub OR use `get_account` to get `provider_code` directly

### Better Path: Skip the Inbox Hub Entirely

The `get_account` response includes `provider_code` (observed value: `2` for Google). This means we can determine Email Provider **directly from the Instantly API** without needing the Google Sheet at all:

```
Campaign -> email_tag_list UUIDs
   -> list_accounts(tag_ids=UUID) -> accounts
      -> get_account(email) -> provider_code (1=?, 2=Google, 3=Outlook?)
```

Provider codes observed:
- `provider_code: 2` = Google (confirmed from `samuel.ryan@rangeusasync.info`)
- Provider codes 1 and 3 need verification with Outlook accounts

### Even Better: Account Counts

`list_accounts(workspace_id, tag_ids=UUID, fetch_all=true)` returns total counts with status breakdown, which could give us active/paused/error counts per tag UUID without fetching individual accounts.

---

## Open Questions

1. **What are provider_code values?** Need to check an Outlook account to confirm the mapping (likely 1=SMTP/other, 2=Google, 3=Outlook, or similar).
2. **Are email tags an Instantly UI-only concept?** They may be created through the Instantly dashboard's "Email Tags" feature and not exposed through the public API's tag endpoints.
3. **Can we create/read email tags via API?** If not, we're stuck with the indirect resolution approach above.
4. **Is the Pair column (Inbox Hub) the organizational unit behind multi-persona email tags?** The Equinox data suggests UUIDs may map to pairs, not individual tags.

---

## Data Samples for Reference

### Inbox Hub Columns (Funding sheet)
Tag | Accounts | Total Daily Cold emails sent | Cold Emails | Warmup Emails | Status | Campaign Manager | Workspace | Deliverability | Need warmup | Group | Pair | Inbox Manager | Renewal Date | Warmup Start Date | Branding | Domain Purchase Date | Type | Technical | Batch | **Email Provider** | Accounts per Domain | Tag Value | Domains | OFFER

### Sample Row
Joan Bonino | 198 | 2,376 | 12 | 40 | Off-Group | Leo | Equinox | Low | TRUE | Group A | 6 | Frank | | Jul 5, 2025 | Affinity Solutions | | Panel | | Emran Batch 6 | **Google** | 4 | 0.2 | 50 | Funding
