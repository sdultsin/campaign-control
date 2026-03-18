# ERC & Section 125 -- Inbox Hub Sheet Mapping

[2026-03-15] Research for auto-turn-off system. Tag-to-infrastructure mappings pulled from Google Sheets Inbox Hub (`1wkrkX_02bdXaj_j-E03vLHIFRw8howadd96LOC4lONo`).

---

## Column Structure Comparison

| Field | Funding | ERC | Section 125 |
|-------|---------|-----|-------------|
| Tag | A | A | A |
| Accounts | B | B | B |
| Total Daily Cold | C | C | C |
| Cold Emails | D | D | D |
| Warmup Emails | E | E | E |
| Status | F | F | F |
| Campaign Manager | G | G | G |
| Workspace | H | H | H |
| Deliverability | I | I | -- |
| Need warmup | J | J | I |
| Group | K | K | J |
| Pair | L | L | -- |
| Inbox Manager | M | M | L |
| Branding | -- (col P) | O | K |
| Renewal Date | N | Y | N |
| Warmup Start Date | O | N | M |
| Domain Purchase Date | Q | P | O |
| Type | R | Q | P |
| Technical | S | R | Q |
| Batch | T | S | R |
| Email Provider | U | T | S |
| Accounts per Domain | V | U | T |
| Tag Value | W | V | U |
| Domains | X | W | V |
| OFFER | Y | X | Z |

Key differences from Funding:
- **Column order diverges** starting around column I/J. Deliverability exists in ERC but not Section 125. Pair exists in ERC/Funding but not Section 125. Branding column position shifts across all three.
- **OFFER column**: Funding = Y, ERC = X, Section 125 = Z. Not in a consistent position.
- **Batch column**: Funding = T, ERC = S, Section 125 = R.
- Any automation reading these sheets needs per-sheet column mappings, not shared offsets.

---

## ERC Sheet Summary

**Total tags:** 50
**Tag range:** RG3465 -- RG3554
**All accounts:** 3,960 per tag (198,000 total inboxes)
**Offer:** ERC (uniform)

### Tags per Provider

| Provider | Tags |
|----------|------|
| Outlook | 50 (100%) |

ERC is entirely Outlook infrastructure.

### Tags per Workspace

| Workspace | Tags | Tag Range |
|-----------|------|-----------|
| ERC 1 | 40 | RG3515 -- RG3554 |
| ERC 2 | 10 | RG3465 -- RG3474 |

### Tags per Campaign Manager

| CM | Tags |
|----|------|
| (none assigned) | 50 |

No CM is assigned to any ERC tag. This is a critical data gap -- it means CM-based filtering for auto-turn-off will not work for ERC unless CMs are populated.

### Tags per Batch

| Batch | Tags | Workspace |
|-------|------|-----------|
| B55 | 40 | ERC 1 |
| B75 | 10 | ERC 2 |

### Tags per Type

| Type | Tags |
|------|------|
| MailIn | 50 (100%) |

### Tags per Status

| Status | Tags |
|--------|------|
| Sent Into Production | 50 |

All tags are in production. One "Cancelled" row exists below the data (no tag ID).

### Workspace-to-Infrastructure Mapping

| Workspace | Provider | Type | Batch | CM |
|-----------|----------|------|-------|----|
| ERC 1 | Outlook | MailIn | B55 | (none) |
| ERC 2 | Outlook | MailIn | B75 | (none) |

---

## Section 125 Sheet Summary

**Total tags:** 245
**Tag range:** RG2128 -- RG4463 (non-contiguous, 6 distinct batches)
**Offer:** Section 125 (uniform)

### Tags per Provider

| Provider | Tags | % |
|----------|------|---|
| Google | 195 | 79.6% |
| Outlook | 50 | 20.4% |

### Tags per Workspace

| Workspace | Tags |
|-----------|------|
| Section125 1 | 175 |
| Section125 2 | 70 |

### Tags per Campaign Manager

| CM | Tags |
|----|------|
| Ido | 45 |
| (none assigned) | 200 |

Only the oldest 45 tags (RG2128-RG2152 and RG2868-RG2887) have Ido assigned. The remaining 200 tags (81.6%) have no CM. Same data gap as ERC.

### Tags per Status

| Status | Tags |
|--------|------|
| Scaling cold volume | 25 |
| Ready to Launch | 20 |
| Sent into Production | 200 |

### Tags per Type (infrastructure vendor)

| Type | Tags | Provider | Notes |
|------|------|----------|-------|
| Reseller | 25 | Google | Oldest batch (B19), Technical: Toukir, Shekhar |
| Outreach Today | 170 | Google | Batches B44.5G, B46, B54, B60. Technical: Outreach Today, Toukir |
| MailIn | 50 | Outlook | Batches B57, B73. Technical: MailIn |

### Tags per Batch (detailed breakdown)

| Batch | Tags | Workspace | Provider | Type | Tag Range | Status |
|-------|------|-----------|----------|------|-----------|--------|
| B19 | 25 | Section125 1 | Google | Reseller | RG2128 -- RG2152 | Scaling cold volume |
| B44.5G | 20 | Section125 1 | Google | Outreach Today | RG2868 -- RG2887 | Ready to Launch |
| B46 | 45 | Section125 1 | Google | Outreach Today | RG3181 -- RG3225 | Sent into Production |
| B46 | 5 | Section125 1 | Google | Outreach Today | RG3276 -- RG3280 | Sent into Production |
| B54 | 50 | Section125 1 | Google | Outreach Today | RG3336 -- RG3385 | Sent into Production |
| B57 | 30 | Section125 2 | Outlook | MailIn | RG3585 -- RG3614 | Sent into Production |
| B60 | 10 | Section125 1 | Google | Outreach Today | RG3386 -- RG3395 | Sent into Production |
| B60 | 40 | Section125 2 | Google | Outreach Today | RG3615 -- RG3654 | Sent into Production |
| B73 | 20 | Section125 1 | Outlook | MailIn | RG4444 -- RG4463 | Sent into Production |

### Workspace-to-Infrastructure Mapping

| Workspace | Provider | Type | Batches | CM |
|-----------|----------|------|---------|-----|
| Section125 1 | Google | Reseller | B19 | Ido (25 tags) |
| Section125 1 | Google | Outreach Today | B44.5G, B46, B54, B60 | Ido (20 tags B44.5G), none (rest) |
| Section125 1 | Outlook | MailIn | B73 | (none) |
| Section125 2 | Outlook | MailIn | B57 | (none) |
| Section125 2 | Google | Outreach Today | B60 | (none) |

---

## Implications for Auto-Turn-Off

### 1. Column mappings must be per-sheet
The three sheets (Funding, ERC, Section 125) have different column positions for key fields. A lookup system needs a column map per sheet:

```
Funding:  { tag: "A", cm: "G", workspace: "H", provider: "U", offer: "Y", batch: "T", status: "F" }
ERC:      { tag: "A", cm: "G", workspace: "H", provider: "T", offer: "X", batch: "S", status: "F" }
S125:     { tag: "A", cm: "G", workspace: "H", provider: "S", offer: "Z", batch: "R", status: "F" }
```

### 2. CM field is mostly empty for ERC and Section 125
- ERC: 0/50 tags have a CM assigned
- Section 125: 45/245 tags have a CM (Ido only)
- Any auto-turn-off logic that routes decisions by CM will fail silently for these products
- Workaround: route by workspace instead, or by tag prefix range

### 3. Infrastructure is simpler than Funding
- ERC: Single provider (Outlook), single type (MailIn), 2 workspaces
- Section 125: Two providers (Google 80%, Outlook 20%), three types (Reseller, OTD, MailIn), 2 workspaces
- Funding has the most heterogeneous infrastructure across many CMs

### 4. Type field matters for provider behavior
The "Type" column (not Email Provider) determines the actual infrastructure vendor:
- **Reseller** = Google Workspace reseller accounts
- **Outreach Today (OTD)** = Outreach Today provisioned Google accounts
- **MailIn** = MailIn provisioned Outlook accounts

This distinction affects warmup parameters, send limits, and cost -- all relevant to turn-off/reset decisions.

### 5. Workspace naming convention
- ERC: `ERC 1`, `ERC 2`
- Section 125: `Section125 1`, `Section125 2`
- Funding: (see Funding sheet)

Workspace names are the most reliable grouping mechanism for these two products since CM is sparse.

### 6. Tag numbering is non-sequential within sheets
Section 125 has tags from RG2128 up to RG4463 across 6 batches, interleaved with Funding and ERC tag numbers. Tag numbers alone cannot identify product -- the sheet/offer column is required.
