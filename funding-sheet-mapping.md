# Funding Tag-to-Infrastructure Mapping

[2026-03-15] Pulled from Inbox Hub spreadsheet (`1wkrkX_02bdXaj_j-E03vLHIFRw8howadd96LOC4lONo`), sheet: `Funding`

**Source columns:** Tag (A), Campaign Manager (G), Workspace (H), Email Provider (U)

---

## Summary Stats

- **Total tags:** 2,240
- **Tags with CM assigned:** 1,346 (60%)
- **Tags with NO CM assigned:** 894 (40%)
- **Unique workspaces:** 18
- **Unique CMs:** 12

---

## Tags by Email Provider

| Provider | Count | % of Total |
|----------|-------|------------|
| Google | 2,041 | 91.1% |
| Outlook | 199 | 8.9% |

No OTD tags exist in Funding. The product runs almost entirely on Google.

---

## Tags by Workspace

| Workspace | Tags | Provider Split |
|-----------|------|----------------|
| Renaissance 5 | 200 | Google=200 |
| Renaissance 2 | 190 | Google=190 |
| Koi and Destroy | 188 | Google=179, Outlook=9 |
| Renaissance 4 | 186 | Google=186 |
| Renaissance 1 | 182 | Google=182 |
| Prospect Power | 180 | Google=180 |
| The Dyad | 175 | Google=175 |
| The Gatekeepers | 150 | Google=150 |
| The Eagles | 144 | Google=141, Outlook=3 |
| Equinox | 141 | Google=132, Outlook=9 |
| Renaissance 3 | 135 | Google=130, Outlook=5 |
| Renaissance 6 | 115 | Google=100, Outlook=15 |
| Automated Applications | 80 | Google=40, Outlook=40 |
| Renaissance 7 | 80 | Google=50, Outlook=30 |
| Outlook 3 | 35 | Outlook=35 |
| Outlook 1 | 28 | Outlook=28 |
| Outlook 2 | 25 | Outlook=25 |
| Warm Leads | 6 | Google=6 |

---

## Tags by Campaign Manager

| CM | Tags | Provider Split |
|----|------|----------------|
| **(unassigned)** | **894** | Google=748, Outlook=146 |
| Ido | 193 | Google=186, Outlook=7 |
| Eyver | 170 | Google=170 |
| Leo | 142 | Google=133, Outlook=9 |
| Brendan | 141 | Google=141 |
| Shaan | 130 | Google=130 |
| Tomi | 128 | Google=119, Outlook=9 |
| Carlos | 120 | Google=120 |
| Lautaro | 115 | Google=115 |
| Alex | 90 | Google=90 |
| Andres | 48 | Google=48 |
| Marcos | 40 | Google=15, Outlook=25 |
| Samuel | 29 | Google=26, Outlook=3 |

---

## Workspace-to-CM Mapping

### Dedicated workspaces (1 CM)

| Workspace | CM |
|-----------|-----|
| Automated Applications | Ido |
| Equinox | Leo |
| Koi and Destroy | Tomi |
| Outlook 1 | Ido |
| Outlook 2 | Marcos |
| Prospect Power | Shaan |
| Renaissance 1 | Ido |
| Renaissance 2 | Eyver |
| The Dyad | Carlos |
| The Gatekeepers | Brendan |
| Warm Leads | Ido |

### Shared workspaces (multiple CMs)

| Workspace | CMs |
|-----------|-----|
| **Renaissance 4** | Alex, Andres, Carlos, Ido, Leo |
| **Renaissance 5** | Alex, Eyver, Marcos |
| **The Eagles** | Lautaro, Samuel |

### Warming workspaces (excluded from auto-turn-off)

These workspaces have tags but no CMs and 0 active campaigns. Confirmed warming by Samuel on 2026-03-16. Excluded from auto-turn-off config until they go live.

| Workspace | Tags | Status |
|-----------|------|--------|
| Renaissance 3 | 135 | Warming |
| Renaissance 6 | 115 | Warming |
| Renaissance 7 | 80 | Warming |
| Outlook 3 | 35 | Warming |

---

## CM-to-Workspace Mapping

| CM | Workspaces |
|----|------------|
| Ido | Automated Applications, Outlook 1, Renaissance 1, Renaissance 4, Warm Leads |
| Alex | Renaissance 4, Renaissance 5 |
| Eyver | Renaissance 2, Renaissance 5 |
| Carlos | Renaissance 4, The Dyad |
| Leo | Equinox, Renaissance 4 |
| Marcos | Outlook 2, Renaissance 5 |
| Lautaro | The Eagles |
| Samuel | The Eagles |
| Brendan | The Gatekeepers |
| Shaan | Prospect Power |
| Tomi | Koi and Destroy |
| Andres | Renaissance 4 |

---

## Key Observations

1. **40% of tags have no CM assigned.** 894 tags lack a Campaign Manager. Four entire workspaces (Renaissance 3, Renaissance 6, Renaissance 7, Outlook 3) have zero CM assignments. This is a gap for any auto-turn-off logic that needs CM-level routing.

2. **Renaissance 4 is heavily shared.** Five CMs operate in it (Alex, Andres, Carlos, Ido, Leo). Any workspace-level action here affects multiple CMs.

3. **Ido spans the most workspaces (5).** He touches Automated Applications, Outlook 1, Renaissance 1, Renaissance 4, and Warm Leads.

4. **Outlook is a small slice.** Only 199 tags (8.9%). Most Outlook tags are concentrated in dedicated Outlook workspaces (1-3) and Automated Applications. The auto-turn-off system is overwhelmingly a Google problem.

5. **No OTD provider exists** in Funding. Provider options are strictly Google and Outlook.

6. **Warm Leads workspace** has only 6 tags, all Google, all Ido. This is likely a special-purpose workspace, not a standard sending workspace.
