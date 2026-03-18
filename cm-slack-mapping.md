# CM Name -> Slack Notification Channel Mapping

**Created:** [2026-03-15]
**Updated:** [2026-03-15] - Added notification channel IDs (replaces DM approach)
**Source:** Slack MCP `list_users` + `search_messages` cross-referenced with campaign naming audit (210+ campaigns, 7 workspaces)

---

## Design Change: Channels Instead of DMs

Darcy/Outreachify already created per-CM notification channels (`notifications-[name]`) with an existing `outreachify_bot` that posts variant alerts. These channels are private but Sam has been added to all 12.

**v1 will post to these existing channels instead of DMs.** Advantages:
- Infrastructure already exists
- CMs are already in these channels
- Sam can monitor all notifications across CMs
- No need for DM-specific bot scopes
- Replaces the broken Outreachify notification bot with actionable auto-turn-off messages

**Bot token:** Still need from Darcy. The `outreachify_bot` already posts to these channels, so either we get that bot's token or create a new bot that's added to the same channels.

---

## Complete CM Mapping

| Campaign Name Pattern | Notification Channel | Channel ID | Slack User ID | Real Name |
|---|---|---|---|---|
| `(EYVER)` | `notifications-eyver` | `C0A7B19L932` | `U08SLA1HQRZ` | Eyver Velazquez |
| `(ANDRES)` | `notifications-andres` | `C0ADASDL7PH` | `U0AD5EJPPC3` | Andres Espinal |
| `(LEO)` | `notifications-leo` | `C0A618T6BF1` | `U094CTQKTB7` | Leonardo Orihuela |
| `(CARLOS)` | `notifications-carlos` | `C0A618X6ST1` | `U09A2LU5ZC6` | Carlos Rivera |
| `(SAMUEL)` | `notifications-samuel` | `C0A6EM740NA` | `U09AMSMQG1E` | Samuel Aureliano |
| `(IDO)`, `(Ido)` | `notifications-ido` | `C0A6GNNG198` | `U06KAUDCFJR` | Ido Rebhun |
| `(Alex)`, `(ALEX)` | `notifications-alex` | `C0A8KUADR4Z` | `U0A6P836HAP` | Alex |
| `(Marcos)`, `(MARCOS)` | `notifications-marcos` | `C0AELJPTF4Y` | `U0AD8DK5ZS9` | Marcos Godoy |
| `- LAUTARO` (no parens) | `notifications-lautaro` | `C0A6GN95VS6` | `U0A5BBE1MV5` | Lautaro Blas |
| `(BRENDAN)` | `notifications-brendan` | `C0A619CL087` | `U09QK41FX8U` | Brendan Goodall |
| `(TOMI)` | `notifications-tomi` | `C0A618H43RV` | `U08SLA0SRLK` | Tomi Manchev |
| `(SHAAN)` | `notifications-shaan` | `C0A6AAMFDNX` | `U09768K5T9Q` | Shaan |

## CMs Without Notification Channels (seen in campaigns)

| Campaign Name Pattern | Slack User ID | Real Name | Notes |
|---|---|---|---|
| `- Ramir` | `U06KAUG5CHK` | Ramir Velasquez | Seen in Renaissance 4 once, no notification channel found |
| `Ellen` | ? | ? | Seen in Equinox nurture campaigns, may not be a CM |
| `Vicky` | ? | ? | Test campaign in The Dyad |

---

## Parser Implementation

```
// Channel lookup (normalize to uppercase for matching):
{
  "EYVER": "C0A7B19L932",
  "ANDRES": "C0ADASDL7PH",
  "LEO": "C0A618T6BF1",
  "CARLOS": "C0A618X6ST1",
  "SAMUEL": "C0A6EM740NA",
  "IDO": "C0A6GNNG198",
  "ALEX": "C0A8KUADR4Z",
  "MARCOS": "C0AELJPTF4Y",
  "LAUTARO": "C0A6GN95VS6",
  "BRENDAN": "C0A619CL087",
  "TOMI": "C0A618H43RV",
  "SHAAN": "C0A6AAMFDNX"
}
```

### Parser logic:
1. Try: extract last `(NAME)` from campaign title, normalize to uppercase
2. Skip `(copy)` tokens - Instantly auto-appends on duplicated campaigns
3. Fallback: extract last `- NAME` token (for Lautaro-style), normalize to uppercase
4. Look up in channel map above
5. If no match -> send to `SLACK_FALLBACK_CHANNEL` (create `#notifications-unassigned` or use an existing ops channel — must be set before live mode)

### Edge cases:
- `(EYVER) RB` - suffix after parens, parser must grab content INSIDE parens only
- `(ANDRES) X` - same pattern
- `(copy)` - skip all `(copy)` tokens, grab previous parenthesized value
- `(CARLOS) (copy) (copy)` -> resolves to CARLOS

---

## Outreachify's Broken Bot (Context)

The `outreachify_bot` already posts daily alerts to these channels (Project 3 from Darcy's requirements doc). It's broken because:
- Notifies on OFF/paused campaigns
- Notifies on variants below 4K gate (e.g., 3,043 sent)
- Massive walls of text with every variant from every campaign
- No action taken - just noise

Our auto-turn-off system replaces this. It posts only when it takes action (or can't take action on the last variant). Clean, actionable messages instead of noise.

**Question for Darcy:** Should the old outreachify_bot notifications be turned off once our system goes live? Otherwise CMs get both the noise AND the actionable messages.
