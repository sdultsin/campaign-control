export const MCP_SSE_URL = 'https://king-instantly-mcp-production.up.railway.app/sse';

export const CM_CHANNEL_MAP: Record<string, string> = {
  'EYVER': 'C0A7B19L932',
  'ANDRES': 'C0ADASDL7PH',
  'LEO': 'C0A618T6BF1',
  'CARLOS': 'C0A618X6ST1',
  'SAMUEL': 'C0A6EM740NA',
  'IDO': 'C0A6GNNG198',
  'ALEX': 'C0A8KUADR4Z',
  'MARCOS': 'C0AELJPTF4Y',
  'LAUTARO': 'C0A6GN95VS6',
  'BRENDAN': 'C0A619CL087',
  'TOMI': 'C0A618H43RV',
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

export const PRODUCT_THRESHOLDS: Record<Product, number> = {
  FUNDING: 4000,   // overridden by per-infra at runtime
  ERC: 6000,
  S125: 14000,
};

/** 20% buffer applied to OFF-campaign thresholds. OFF campaigns get more runway before kill. */
export const OFF_CAMPAIGN_BUFFER = 1.2;

/**
 * Runway extension for variants that have opportunities but exceed the base threshold.
 * Applied as a multiplier: effective_threshold = threshold * OPP_RUNWAY_MULTIPLIER.
 * Only applies when opportunities > 0. Zero-opp variants use the base threshold.
 * Stacks with OFF_CAMPAIGN_BUFFER (applied earlier in resolveThreshold).
 */
export const OPP_RUNWAY_MULTIPLIER = 1.1;

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
  { id: 'outlook-3', name: 'Outlook 3', product: 'FUNDING', defaultCm: 'LEO' },
  { id: 'prospects-power', name: 'Prospects Power', product: 'FUNDING', defaultCm: 'SHAAN' },
  { id: 'automated-applications', name: 'Automated applications', product: 'FUNDING', defaultCm: 'EYVER' },
  { id: 'outlook-1', name: 'Outlook 1', product: 'FUNDING', defaultCm: 'IDO' },
  // Funding - shared workspaces (no single default CM)
  { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null },
  { id: 'renaissance-5', name: 'Renaissance 5', product: 'FUNDING', defaultCm: null },
  { id: 'the-eagles', name: 'The Eagles', product: 'FUNDING', defaultCm: null },
  // Excluded: Renaissance 3, Renaissance 6, Renaissance 7
  // Warming up as of 2026-03-16 (confirmed by Samuel). No CMs assigned, 0 active campaigns.
  // Re-add when they go live.
  // ERC
  { id: 'erc-1', name: 'ERC 1', product: 'ERC', defaultCm: null },
  { id: 'erc-2', name: 'ERC 2', product: 'ERC', defaultCm: null },
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
export const WORKSPACE_CM_EXCLUSIONS: Record<string, Set<string>> = {
  'the-eagles': new Set(['SAMUEL']),
};

// ---------------------------------------------------------------------------
// Pilot mode: only these CMs get evaluated and notified.
// Remove this filter (or empty the set) to go full-fleet.
// ---------------------------------------------------------------------------
export const PILOT_CMS: Set<string> = new Set(['ALEX', 'CARLOS', 'EYVER', 'IDO', 'LAUTARO', 'LEO', 'MARCOS', 'SAMUEL', 'TOMI']);

// ---------------------------------------------------------------------------
// Per-CM dry run: CMs in this set are evaluated and logged (dashboard populates)
// but variants are NOT killed and Slack notifications are NOT sent.
// Remove a CM from this set to go live with kills for them.
// ---------------------------------------------------------------------------
export const DRY_RUN_CMS: Set<string> = new Set([]);

// CM -> Slack channel for monitor notifications
export const CM_MONITOR_CHANNELS: Record<string, string> = {
  'ALEX': 'C0AN70F328G',     // #cc-alex
  'CARLOS': 'C0AMRK81MRP',   // #cc-carlos
  'EYVER': 'C0AN6L2KLLW',    // #cc-eyver
  'IDO': 'C0AMRK842PK',      // #cc-ido
  'LAUTARO': 'C0AMXSTGEF9',  // #cc-lautaro
  'LEO': 'C0ANK3F1ED8',      // #cc-leo
  'MARCOS': 'C0ANH1S3K2S',   // #cc-marcos
  'SAMUEL': 'C0AMCMVLVDG',   // #cc-samuel
  'TOMI': 'C0ANFLJPS69',     // #cc-tomi
};

// Max variants to disable per cron run. Remaining candidates are logged as
// DEFERRED and picked up in the next hourly run. Prevents a large initial
// purge from hitting rate limits or creating excessive blast radius.
// Set to 0 for unlimited.
export const MAX_KILLS_PER_RUN = 10;

export const LAST_VARIANT_WARNING_PCT = 0.65;
export const WARNING_DEDUP_TTL_SECONDS = 86400;
export const KILL_DEDUP_TTL_SECONDS = 604800; // 7 days (same as blocked)
// Secondary rescan: how long to wait before rechecking disabled variants
export const RESCAN_DELAY_HOURS = 4;
// TTL for rescan queue entries in KV (auto-cleanup after 48 hours)
export const RESCAN_TTL_SECONDS = 172800;
// Maximum window for redemption (explicit expiration check in code)
export const RESCAN_MAX_WINDOW_HOURS = 48;

// Leads depletion monitor: dedup TTLs
export const LEADS_WARNING_DEDUP_TTL_SECONDS = 172800;   // 48 hours
export const LEADS_EXHAUSTED_DEDUP_TTL_SECONDS = 172800;  // 48 hours

// Leads depletion monitor: absolute thresholds (replaces dailyLimit-based logic)
export const LEADS_EXHAUSTED_THRESHOLD = 0;
export const LEADS_WARNING_THRESHOLD = 5000;

// Kill persistence monitor: max KV keys to check per run
export const MAX_PERSISTENCE_CHECKS = 100;

// Ghost exemption: TTL for exempt keys (90 days). Prevents CC from re-killing a CM-re-enabled variant.
export const EXEMPT_TTL_SECONDS = 7776000; // 90 days

// Ghost Slack notification dedup TTL (90 days). Fires once per ghost.
export const GHOST_NOTIFIED_TTL_SECONDS = 7776000; // 90 days

// Per-item Slack notifications are intentionally suppressed (CM Supervision Console).
// When true, checkSlackDelivery() returns PASS instead of flagging reply_success=false rows.
// Flip to false when per-item Slack is re-enabled.
export const SLACK_SUPPRESSED = true;

// Dashboard
export const DASHBOARD_BASE_URL = 'https://cm-dashboard-sable.vercel.app';
export const CRON_HOURS_UTC = [10, 16, 19, 23]; // Eval runs only (excludes 12:00 digest). For "Next scan" computation.
