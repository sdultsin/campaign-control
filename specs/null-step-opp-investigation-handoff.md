# Null-Step Opp Investigation -- Handoff

**Date:** [2026-03-20]
**Spec:** `specs/null-step-opp-investigation.md`
**Status:** CLOSED -- no code changes needed

---

## What was investigated

The Instantly `get_step_analytics` endpoint sometimes returns rows where `step` is `null` or `"null"`. CC's evaluator filters these out via `parseInt("null", 10)` returning NaN. The concern was that opps on these null-step rows could be "stolen" from real variants, making variants look worse than they are and causing false-positive kills.

## What was done

Sampled 20 active campaigns across 4 workspaces (the-dyad, renaissance-1, the-eagles, equinox) using the Instantly MCP tools. For each campaign:
- Fetched step analytics with `include_opportunities=true`
- Checked for null-step rows and recorded their opp counts
- Fetched campaign-level analytics for cross-validation
- Computed deltas between step-level opp sums and campaign-level totals

## Key findings

| Finding | Detail |
|---------|--------|
| Null-step row prevalence | 20/20 campaigns (100%) have at least one null-step row |
| Null-step rows with opps | 5/20 campaigns (25%) have opps on null-step rows |
| Null-step opp volume | ~1.4% of total opps (de-duplicated across duplicate null rows) |
| Variant-level accuracy | Confirmed -- 6/6 exact match vs Instantly UI (March 20 12pm audit) |
| Larger gap discovered | Some campaigns show 8-11 opps missing from step analytics entirely (not on null-step rows). Likely subsequence opps. |
| False-positive kill risk | Zero in this 20-campaign sample under current thresholds |

## Decision

**Accept the risk. No code changes.**

The null-step opps are genuinely orphaned -- not stolen from real variants. Variant-level data matches what CMs see in the Instantly UI. A cross-validation gate spec was drafted but rejected as over-engineering. CC should follow human CM logic: compare variant opps to variant sent, kill if above threshold. CMs don't factor in null-step or unattributed opps, and neither should CC.

## Files modified

- `specs/null-step-opp-investigation.md` -- added investigation results and decision to the spec

## No action needed

This investigation is complete. Nothing to build, deploy, or verify.
