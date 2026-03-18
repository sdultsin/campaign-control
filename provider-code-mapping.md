# Instantly provider_code Mapping

[2026-03-15] Research task to map Instantly API `provider_code` values to infrastructure types.

## Confirmed Mapping

| provider_code | Provider Type | How Confirmed |
|---------------|--------------|---------------|
| 1 | SMTP (OTD / Outreach Today Domains) | Section 125 1 accounts with `.co` domains (e.g., `classguardvital.co`) return code 1. No OAuth fields. Added via API by OTD provisioning. |
| 2 | Google (Gmail / Google Workspace) | Renaissance 1 (funding/Google workspace) accounts return code 2. Error messages show `AUTH XOAUTH2`. Previously confirmed. |
| 3 | Outlook (Microsoft 365) | ERC 1 (100% Outlook) and Outlook 1/2/3 workspaces all return code 3 exclusively. |
| 4 | Not used | 0 accounts across all tested workspaces. |
| 0, 5+ | Invalid | API rejects with "must be equal to one of the allowed values." Valid range is 1-4. |

## Workspace Verification

| Workspace | Code 1 (SMTP) | Code 2 (Google) | Code 3 (Outlook) | Total |
|-----------|--------------|-----------------|-------------------|-------|
| ERC 1 | 0 | 0 | 100,000 | 100,000 |
| ERC 2 | 0 | 0 | 0 | 0 (empty) |
| Outlook 1 | 0 | 0 | 38,943 | 38,943 |
| Outlook 2 | 0 | 0 | 66,320 | 66,320 |
| Outlook 3 | -- | -- | 44,958 | 44,958 |
| Renaissance 1 | 0 | 12,214 | 0 | 12,214 |
| Section 125 1 | 6,058 | 4,300 | 0 | 10,358 |
| Section 125 2 | 4,967 | 0 | 100,000 | 104,967 |

Section 125 is a mixed-provider product line: SMTP (OTD) + Google in S125-1, SMTP (OTD) + Outlook in S125-2.

## Useful Account Object Fields

Fields returned by `get_account` (individual account detail):

| Field | Description | Example Values |
|-------|-------------|----------------|
| `provider_code` | Infrastructure type (1/2/3) | See mapping above |
| `status` | Account health | `1` = active, `-1` = error |
| `warmup_status` | Warmup state | `0` = paused, `1` = active, `-1` = banned |
| `daily_limit` | Sending cap per day | 5, 15, 20, 30 |
| `sending_gap` | Seconds between sends | 10, 13, 17, 61 |
| `enable_slow_ramp` | Gradual volume increase | true/false |
| `warmup_pool_id` | Warmup pool assignment | `"premium-v1"` |
| `stat_warmup_score` | Warmup health score | 0-100 |
| `added_by` | Who added (UUID or "api") | `"api"`, UUID string |
| `setup_pending` | Still being provisioned | true/false |
| `is_managed_account` | Managed account flag | true/false |
| `status_message` | Error details (when status=-1) | `{code: "EAUTH", command: "AUTH XOAUTH2", ...}` |
| `inbox_placement_test_limit` | IPT allowance | 0, 3 |
| `signature` | HTML email signature | HTML string with Instantly variables |
| `organization` | Org UUID | UUID string |

## API Filter Notes

- `list_accounts` accepts `provider_code` as a filter parameter (values 1-4 only)
- Combined with `fetch_all=true`, this gives instant counts by provider per workspace
- `provider_code=4` is accepted by the API but returns 0 results everywhere -- likely reserved for a future provider or deprecated
