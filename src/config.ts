export const MCP_SSE_URL = 'https://king-instantly-mcp-production.up.railway.app/sse';

export const CM_CHANNEL_MAP: Record<string, string> = {
  'EYVER': 'C0A7B19L932',
  'ANDRES': 'C0ADASDL7PH',
  'LEO': 'C0A618T6BF1',
  'CARLOS': 'C0A618X6ST1',
  'IDO': 'C0A6GNNG198',
  'ALEX': 'C0A8KUADR4Z',
  'MARCOS': 'C0AELJPTF4Y',
  'LAUTARO': 'C0A6GN95VS6',
  'BRENDAN': 'C0A619CL087',
  'TOMI': 'C0A618H43RV',
  'SAM': 'C0AR0EA21C1',
  'SHAAN': 'C0A6AAMFDNX',
};

export const VARIANT_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export type Product = 'FUNDING' | 'ERC' | 'S125';

export const PROVIDER_THRESHOLDS: Record<number, number> = {
  1: 4500,  // SMTP / OTD
  2: 3800,  // Google
  3: 5000,  // Outlook
};
export const DEFAULT_THRESHOLD = 4000;

/**
 * Workspaces whose campaigns should always use the Outlook (5000) threshold,
 * regardless of the infra_type value in Pipeline Supabase. Used when the
 * workspace is known to run on Outlook infra but pipeline classification is
 * unreliable.
 */
export const OUTLOOK_KPI_WORKSPACES = new Set<string>([
  'automated-applications',
  'renaissance-3',
  'renaissance-6',
  'erc-1',
  'erc-2',
]);

export const PRODUCT_THRESHOLDS: Record<Product, number> = {
  FUNDING: 4000,   // overridden by per-infra at runtime
  ERC: 6000,
  S125: 14000,
};

/** 20% buffer applied to OFF-campaign thresholds. OFF campaigns get more runway before kill. */
export const OFF_CAMPAIGN_BUFFER = 1.2;

/**
 * Step-position multipliers for kill thresholds. Follow-up steps naturally
 * convert worse than step 1; multiplier gives them proportionally more runway.
 * Applied to the resolved base threshold (after product/provider, before opp runway).
 * 0-indexed to match Instantly step indices.
 */
export const STEP_MULTIPLIERS: Record<number, number> = {
  0: 1.0,   // Step 1: no change
  1: 1.3,   // Step 2: 30% more runway
  2: 1.6,   // Step 3: 60% more runway
  3: 2.0,   // Step 4: 2x runway
};
export const STEP_MULTIPLIER_CAP = 2.0; // Step 5+ use this cap

/** Return the step-position multiplier for a given 0-indexed step. */
export function getStepMultiplier(stepIndex: number): number {
  return STEP_MULTIPLIERS[stepIndex] ?? STEP_MULTIPLIER_CAP;
}

/** 1-opp runway: give single-opportunity variants extra room before killing.
 *  Rationale: one more opp could halve the ratio. 2+ opp variants get no multiplier
 *  - their ratio already has statistical weight. */
export const SINGLE_OPP_RUNWAY_MULTIPLIER = 1.5;

/** Winner threshold = kill threshold * WINNER_THRESHOLD_MULTIPLIER (0.66x). */
export const WINNER_THRESHOLD_MULTIPLIER = 0.66;

/** Minimum opportunities required to qualify as a winner. Eliminates low-sample flukes. */
export const WINNER_MIN_OPPS = 5;

/** Minimum sends = kill_threshold * WINNER_MIN_SENDS_MULTIPLIER. Variant must have been in market long enough. */
export const WINNER_MIN_SENDS_MULTIPLIER = 0.5;

export interface WorkspaceConfig {
  id: string;
  name: string;
  product: Product;
  defaultCm: string | null;
}

export const WORKSPACE_CONFIGS: WorkspaceConfig[] = [
  // Funding - single-CM workspaces
  { id: 'renaissance-1', name: 'Renaissance 1', product: 'FUNDING', defaultCm: 'IDO' },
  { id: 'renaissance-2', name: 'Renaissance 2', product: 'FUNDING', defaultCm: 'EYVER' },
  { id: 'the-gatekeepers', name: 'The Gatekeepers', product: 'FUNDING', defaultCm: 'BRENDAN' },
  { id: 'equinox', name: 'Equinox', product: 'FUNDING', defaultCm: 'LEO' },
  { id: 'the-dyad', name: 'The Dyad', product: 'FUNDING', defaultCm: 'CARLOS' },
  { id: 'koi-and-destroy', name: 'Koi and Destroy', product: 'FUNDING', defaultCm: 'TOMI' },
  { id: 'outlook-2', name: 'Outlook 2', product: 'FUNDING', defaultCm: 'MARCOS' },
  { id: 'prospects-power', name: 'Prospects Power', product: 'FUNDING', defaultCm: 'SHAAN' },
  { id: 'automated-applications', name: 'Automated applications', product: 'FUNDING', defaultCm: 'EYVER' },
  { id: 'outlook-1', name: 'Outlook 1', product: 'FUNDING', defaultCm: 'IDO' },
  // Funding - shared workspaces (no single default CM)
  { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null },
  { id: 'renaissance-5', name: 'Renaissance 5', product: 'FUNDING', defaultCm: null },
  { id: 'the-eagles', name: 'The Eagles', product: 'FUNDING', defaultCm: null },
  { id: 'outlook-3', name: 'Outlook 3', product: 'FUNDING', defaultCm: null },
  { id: 'renaissance-3', name: 'Renaissance 3', product: 'FUNDING', defaultCm: 'SAM' },
  { id: 'renaissance-6', name: 'Renaissance 6', product: 'FUNDING', defaultCm: 'SAM' },
  { id: 'renaissance-7', name: 'Renaissance 7', product: 'FUNDING', defaultCm: null },
  // Tariffs + Funding (legacy slug erc-1, renamed in Instantly UI 2026-04-15)
  { id: 'erc-1', name: 'Tariffs + Funding', product: 'FUNDING', defaultCm: 'SAM' },
  // ERC
  { id: 'erc-2', name: 'ERC 2', product: 'FUNDING', defaultCm: 'ANDRES' },
  // S125
  { id: 'section-125-1', name: 'Section 125 1', product: 'S125', defaultCm: 'IDO' },
  { id: 'section-125-2', name: 'Section 125 2', product: 'S125', defaultCm: null },
  // Warm Leads — excluded from pilot. KPIs are fundamentally different from cold
  // outreach (warm follow-ups convert at much higher rates). Will revisit with
  // Ido to define proper thresholds before adding.
  // { id: 'warm-leads', name: 'Warm leads', product: 'WARM_LEADS', defaultCm: 'IDO' },
];

export function getWorkspaceConfig(workspaceId: string): WorkspaceConfig | null {
  return WORKSPACE_CONFIGS.find((c) => c.id === workspaceId) ?? null;
}

// ---------------------------------------------------------------------------
// Workspace-level CM exclusions. Campaigns resolving to an excluded CM
// in a specific workspace are skipped (e.g. CM moved workspaces but old
// campaigns remain). Does not affect the CM in other workspaces.
// ---------------------------------------------------------------------------
export const WORKSPACE_CM_EXCLUSIONS: Record<string, Set<string>> = {};

// ---------------------------------------------------------------------------
// Pilot mode: only these CMs get evaluated and notified.
// Remove this filter (or empty the set) to go full-fleet.
// ---------------------------------------------------------------------------
export const PILOT_CMS: Set<string> = new Set(['ALEX', 'ANDRES', 'BRENDAN', 'CARLOS', 'EYVER', 'IDO', 'LAUTARO', 'LEO', 'MARCOS', 'SAM', 'SHAAN', 'TOMI']);

// ---------------------------------------------------------------------------
// Per-CM dry run: CMs in this set are evaluated and logged (dashboard populates)
// but variants are NOT killed and Slack notifications are NOT sent.
// Remove a CM from this set to go live with kills for them.
// ---------------------------------------------------------------------------
export const DRY_RUN_CMS: Set<string> = new Set([]);

// CM -> Slack channel for monitor notifications
export const CM_MONITOR_CHANNELS: Record<string, string> = {
  'ALEX': 'C0AN70F328G',     // #cc-alex
  'ANDRES': 'C0ARKJEAFRN',   // #cc-andres
  'BRENDAN': 'C0AQJUGGBK5',  // #cc-brendan
  'CARLOS': 'C0AMRK81MRP',   // #cc-carlos
  'EYVER': 'C0AN6L2KLLW',    // #cc-eyver
  'IDO': 'C0AMRK842PK',      // #cc-ido
  'LAUTARO': 'C0AMXSTGEF9',  // #cc-lautaro
  'LEO': 'C0ANK3F1ED8',      // #cc-leo
  'MARCOS': 'C0ANH1S3K2S',   // #cc-marcos
  'SAM': 'C0AR0EA21C1',       // #cc-sam
  'SHAAN': 'C0AQMTQTM6H',   // #cc-shaan
  'TOMI': 'C0ANFLJPS69',     // #cc-tomi
};

// Max variants to disable per cron run. Remaining candidates are logged as
// DEFERRED and picked up in the next hourly run. Prevents a large initial
// purge from hitting rate limits or creating excessive blast radius.
// Set to 0 for unlimited.
export const MAX_KILLS_PER_RUN = 10;

export const LAST_VARIANT_WARNING_PCT = 0.7;
export const WARNING_DEDUP_TTL_SECONDS = 86400;
export const KILL_DEDUP_TTL_SECONDS = 604800; // 7 days (same as blocked)
// Secondary rescan: how long to wait before rechecking disabled variants
export const RESCAN_DELAY_HOURS = 1;
// TTL for rescan queue entries in KV (auto-cleanup after 48 hours)
export const RESCAN_TTL_SECONDS = 172800;
// Maximum window for redemption (explicit expiration check in code)
export const RESCAN_MAX_WINDOW_HOURS = 48;

// Leads depletion monitor: dedup TTLs
export const LEADS_WARNING_DEDUP_TTL_SECONDS = 172800;   // 48 hours
export const LEADS_EXHAUSTED_DEDUP_TTL_SECONDS = 172800;  // 48 hours

// Leads depletion monitor: absolute thresholds (replaces dailyLimit-based logic)
export const LEADS_EXHAUSTED_THRESHOLD = 100;
export const LEADS_WARNING_THRESHOLD = 10000;

// Leads monitor: master switch. When false, Phase 3 is skipped entirely.
// Re-enabled 2026-04-16 after the lead_sequence_started column rename made
// the data trustworthy. See handoffs/2026-04-16-lead-column-rename-execution.md.
export const LEADS_MONITOR_ENABLED = true;

// Leads monitor pilot: only these CMs generate LEADS_EXHAUSTED / LEADS_WARNING
// notifications. Independent of PILOT_CMS (which gates kill/winner/warning
// eval for the whole worker). Empty set = full fleet. Separate gate so we
// can expand leads monitoring independently of the rest of CC.
export const LEADS_MONITOR_PILOT_CMS: Set<string> = new Set(['LEO', 'ANDRES']);

// Leads monitor Slack suppression. When true, LEADS_EXHAUSTED / LEADS_WARNING
// do NOT fire per-CM Slack messages - dashboard items only. Audit + KV dedup
// still write normally. Flip to false when expanding past the dashboard-only
// pilot.
export const LEADS_MONITOR_SLACK_ENABLED = false;

/**
 * Campaigns with fewer than this many leads are "warm leads" campaigns.
 * Warm campaigns are excluded from ALL CC scanning — no variant eval,
 * no kills, no leads monitoring. These are small, curated lists sent
 * to known contacts; cold-outreach KPIs are not applicable.
 */
export const WARM_LEADS_THRESHOLD = 5000;

// Kill persistence monitor: max KV keys to check per run
export const MAX_PERSISTENCE_CHECKS = 100;

// Ghost exemption: TTL for exempt keys (90 days). Prevents CC from re-killing a CM-re-enabled variant.
export const EXEMPT_TTL_SECONDS = 7776000; // 90 days

// Ghost Slack notification dedup TTL (90 days). Fires once per ghost.
export const GHOST_NOTIFIED_TTL_SECONDS = 7776000; // 90 days

// Uniform underperformance: dedup TTL for the STEP_NEEDS_COPY notification
export const STEP_NEEDS_COPY_DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Per-item Slack notifications are intentionally suppressed (CM Supervision Console).
// When true, checkSlackDelivery() returns PASS instead of flagging reply_success=false rows.
// Flip to false when per-item Slack is re-enabled.
export const SLACK_SUPPRESSED = true;

// Dashboard
export const DASHBOARD_BASE_URL = 'https://cm-dashboard-sable.vercel.app';
export const CRON_HOURS_UTC = [10, 13, 14, 16, 18, 19, 21, 23]; // Eval runs only (excludes 12:00 digest). For "Next scan" computation.

// ---------------------------------------------------------------------------
// Send-volume anomaly check (Sam pilot)
// ---------------------------------------------------------------------------
// Hourly 17:00-22:00 UTC (1pm-6pm EDT). Compares today's `sent` vs. the
// expected daily volume derived from the campaign's RG batch tags + the
// PAIR_VOLUME map. Alerts fire once per (campaign, UTC day, direction) with
// KV dedup. Dashboard-only (no Slack). Spec:
// specs/2026-04-16-cc-send-volume-anomaly-alert.md.
//
// NOTE on DST: the 17:00-22:00 UTC window maps to 1pm-6pm EDT during daylight
// saving time. When DST ends in November 2026, the same window becomes 12pm-5pm
// EST -- acceptable for pilot; revisit if pilot extends.

/** Hours (UTC) at which the send-volume anomaly check fires. */
export const SEND_VOLUME_CHECK_HOURS_UTC: Set<number> = new Set([17, 18, 19, 20, 21, 22]);

/** Feature flag. Flip to false to disable the whole check without redeploy gymnastics. */
export const SEND_VOLUME_CHECK_ENABLED = true;

/** Ratio bands. ratio < UNDER_RATIO fires UNDER, ratio > OVER_RATIO fires OVER. */
export const SEND_VOLUME_UNDER_RATIO = 0.70; // -30%
export const SEND_VOLUME_OVER_RATIO = 1.20;  // +20%

/** KV dedup TTL for send-volume alerts. 36h so it covers a full UTC day. */
export const SEND_VOLUME_DEDUP_TTL_SECONDS = 36 * 60 * 60;

/** Sam-only gate. Add other CMs here once Sam pilot proves value (spec §15). */
export const SEND_VOLUME_PILOT_CMS: Set<string> = new Set(['SAM']);

/** Substring that must appear in campaign_name (case-insensitive) for Sam eligibility. */
export const SEND_VOLUME_SAM_NAME_SUBSTR = '(sam)';

/**
 * Pair -> expected daily send volume. Source: Inbox Hub Google Sheet, Funding
 * tab, rows 1033-1178, columns C+L (verified 2026-04-16). Manually refresh
 * when Sam adds new pairs or relaunches.
 */
export const PAIR_VOLUME: Record<string, number> = {
  // Renaissance 3 (William, Bintley Finance)
  'Pair 1': 23049,   // RG3281+RG3282
  'Pair 2': 34560,   // RG3283+RG3284+RG3285

  // Renaissance 6 (Jessica + others, Hey Lending / Bintley Finance / Crestora)
  'Pair 3': 23061,   // RG3445+RG3446
  'Pair 4': 23055,   // RG3447+RG3449
  'Pair 5': 11880,   // RG3448
  'Pair 6': 35640,   // RG3450+RG3451+RG3452
  'Pair 7': 23760,   // RG3453+RG3454
  'Pair 8': 35640,   // RG3455+RG3456+RG3457
  'Pair 9': 23760,   // RG3458+RG3459

  // Tariffs + Funding (NM/RB, Millrun Growth)
  'Pair 10': 23760,  // RG3527+RG3528
  'Pair 11': 23760,  // RG3529+RG3530
  'Pair 12': 23760,  // RG3531+RG3532
  'Pair 13': 23760,  // RG3533+RG3534
  'Pair 14': 23760,  // RG3535+RG3536
  'Pair 15': 23760,  // RG3537+RG3538
  'Pair 16': 23760,  // RG3539+RG3540
  'Pair 17': 23760,  // RG3541+RG3542
  'Pair 18': 23760,  // RG3543+RG3544
  'Pair 19': 23760,  // RG3545+RG3546
  'Pair 20': 23760,  // RG3547+RG3548
  'Pair 21': 23760,  // RG3549+RG3550
  'Pair 22': 23760,  // RG3551+RG3552
  'Pair 23': 23760,  // RG3553+RG3554
};

/**
 * Deterministic lookup from RG batch tag to pair. Generated from the same
 * Sheet rows as PAIR_VOLUME. If a campaign's RG tag is missing here, the
 * check logs and skips (no alert) -- see spec §9.
 */
export const RG_TO_PAIR: Record<string, string> = {
  'RG3281': 'Pair 1',  'RG3282': 'Pair 1',
  'RG3283': 'Pair 2',  'RG3284': 'Pair 2',  'RG3285': 'Pair 2',
  'RG3445': 'Pair 3',  'RG3446': 'Pair 3',
  'RG3447': 'Pair 4',  'RG3449': 'Pair 4',
  'RG3448': 'Pair 5',
  'RG3450': 'Pair 6',  'RG3451': 'Pair 6',  'RG3452': 'Pair 6',
  'RG3453': 'Pair 7',  'RG3454': 'Pair 7',
  'RG3455': 'Pair 8',  'RG3456': 'Pair 8',  'RG3457': 'Pair 8',
  'RG3458': 'Pair 9',  'RG3459': 'Pair 9',
  'RG3527': 'Pair 10', 'RG3528': 'Pair 10',
  'RG3529': 'Pair 11', 'RG3530': 'Pair 11',
  'RG3531': 'Pair 12', 'RG3532': 'Pair 12',
  'RG3533': 'Pair 13', 'RG3534': 'Pair 13',
  'RG3535': 'Pair 14', 'RG3536': 'Pair 14',
  'RG3537': 'Pair 15', 'RG3538': 'Pair 15',
  'RG3539': 'Pair 16', 'RG3540': 'Pair 16',
  'RG3541': 'Pair 17', 'RG3542': 'Pair 17',
  'RG3543': 'Pair 18', 'RG3544': 'Pair 18',
  'RG3545': 'Pair 19', 'RG3546': 'Pair 19',
  'RG3547': 'Pair 20', 'RG3548': 'Pair 20',
  'RG3549': 'Pair 21', 'RG3550': 'Pair 21',
  'RG3551': 'Pair 22', 'RG3552': 'Pair 22',
  'RG3553': 'Pair 23', 'RG3554': 'Pair 23',
};

/**
 * Map from campaign_data.workspace_name (pipeline value) to the Instantly
 * workspace slug used by INSTANTLY_API_KEYS / InstantlyDirectApi. The
 * pipeline writes display names ("Renaissance 3"), but the API key map is
 * keyed on slugs. "Tariffs + Funding" was renamed from "erc-1" in the UI
 * but the slug stuck -- hence the legacy mapping.
 */
export const SEND_VOLUME_WORKSPACE_SLUG: Record<string, string> = {
  'Renaissance 3': 'renaissance-3',
  'Renaissance 6': 'renaissance-6',
  'Tariffs + Funding': 'erc-1',
};
