import type { Product } from './config';

// MCP response types
export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
}

// Instantly data types
export interface Workspace {
  id: string;
  name: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
}

export interface StepAnalytics {
  step: string;
  variant: string;
  sent: number;
  replies: number;
  unique_replies: number;
  opportunities: number;
  unique_opportunities: number;
}

export interface LeadCounts {
  total_leads: number;
  status: {
    completed: number;
    active: number;
    skipped: number;
    bounced: number;
    unsubscribed: number;
  };
}

export interface LeadsCheckCandidate {
  workspaceId: string;
  workspaceName: string;
  campaignId: string;
  campaignName: string;
  cmName: string | null;
  dailyLimit: number;
  channelId: string;
}

export interface LeadsWarningEntry {
  campaignId: string;
  campaignName: string;
  workspaceId: string;
  workspaceName: string;
  cmName: string | null;
  alertedAt: string;
  active_in_sequence: number;
  totalLeads: number;
  dailyLimit: number;
}

export interface LeadsExhaustedEntry {
  campaignId: string;
  campaignName: string;
  workspaceId: string;
  workspaceName: string;
  cmName: string | null;
  alertedAt: string;
  totalLeads: number;
}

export interface LeadsAuditEntry {
  timestamp: string;
  action: 'LEADS_WARNING' | 'LEADS_EXHAUSTED' | 'LEADS_RECOVERED';
  workspace: string;
  workspaceId: string;
  campaign: string;
  campaignId: string;
  cm: string | null;
  leads: {
    total: number;
    contacted: number;
    active_in_sequence: number;
    completed: number;
    /** Active leads from count_leads endpoint — leads that haven't completed the sequence */
    active: number;
    bounced: number;
    skipped: number;
    unsubscribed: number;
    dailyLimit: number;
    source?: 'batch' | 'mcp';
  };
  dryRun: boolean;
}

export type LeadsStatus = 'HEALTHY' | 'WARNING' | 'EXHAUSTED' | 'SKIPPED';

export interface LeadsDepletionResult {
  status: LeadsStatus;
  uncontacted: number;
  totalLeads: number;
}

export interface Variant {
  subject: string;
  body: string;
  v_disabled?: boolean;
  [key: string]: unknown;
}

export interface Step {
  type: string;
  delay: number;
  delay_unit: string;
  variants: Variant[];
  [key: string]: unknown;
}

export interface Sequence {
  steps: Step[];
  [key: string]: unknown;
}

export interface CampaignDetail {
  id: string;
  name: string;
  status: string;
  sequences: Sequence[];
  email_tag_list?: string[];
  timestamp_created?: string;
  [key: string]: unknown;
}

// Decision types
export type DecisionAction = 'SKIP' | 'KEEP' | 'KILL_CANDIDATE';

export interface Decision {
  action: DecisionAction;
  reason: string;
}

export type NotificationType = 'LAST_VARIANT' | 'DOWN_TO_ONE' | null;

export interface SafetyResult {
  canKill: boolean;
  notify: NotificationType;
  remainingActive: number;
}

export interface KillAction {
  workspaceName: string;
  workspaceId: string;
  campaignId: string;
  campaignName: string;
  stepIndex: number;
  variantIndex: number;
  sent: number;
  opportunities: number;
  ratio: string;
  threshold: number;
  notification: NotificationType;
  survivingVariantCount: number;
  isOff: boolean;
}

// Environment bindings
export interface Env {
  KV: KVNamespace;
  ON_DEMAND_QUEUE: Queue;
  DRY_RUN: string;
  CONCURRENCY_CAP: string;
  SLACK_BOT_TOKEN: string;
  SLACK_FALLBACK_CHANNEL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  KILLS_ENABLED: string;
  INSTANTLY_API_KEYS: string;  // JSON map: { "workspace-slug-or-name": "base64-api-key", ... }
  INSTANTLY_MODE: string; // "direct" | "mcp"
  AUDIT_SLACK_CHANNEL: string;  // Channel for audit digests (default: #cc-admin)
}

export interface LastVariantWarning {
  warn: true;
  variantIndex: number;
  variantLabel: string;
  sent: number;
  threshold: number;
  remaining: number;
  pctConsumed: number;
  opportunities: number;
  isOff: boolean;
}

export interface RescanEntry {
  workspaceId: string;
  workspaceName: string;
  campaignId: string;
  campaignName: string;
  stepIndex: number;
  variantIndex: number;
  variantLabel: string;
  disabledAt: string;
  sent: number;
  opportunities: number;
  threshold: number;
  cmName: string | null;
  product: Product;
}

export interface WinnerEntry {
  campaignId: string;
  campaignName: string;
  workspaceId: string;
  workspaceName: string;
  stepIndex: number;
  variantIndex: number;
  variantLabel: string;
  sent: number;
  opportunities: number;
  ratio: number;
  winnerThreshold: number;
  killThreshold: number;
  cm: string | null;
  product: Product;
  isOff: boolean;
}

export interface AuditEntry {
  timestamp: string;
  action: 'DISABLED' | 'BLOCKED' | 'WARNING' | 'RE_ENABLED' | 'STEP_UNFROZEN' | 'EXPIRED' | 'CM_OVERRIDE' | 'DEFERRED' | 'MANUAL_REVERT' | 'GHOST_REENABLE' | 'WINNER_DETECTED' | 'STEP_FROZEN';
  workspace: string;
  workspaceId: string;
  campaign: string;
  campaignId: string;
  /** 1-indexed step number matching Instantly UI and Slack display */
  step: number;
  variant: number;
  variantLabel: string;
  cm: string | null;
  product: Product;
  trigger: {
    sent: number;
    opportunities: number;
    ratio: string;
    threshold: number;
    effective_threshold?: number;
    rule: string;
  };
  safety: {
    survivingVariants: number;
    notification: string | null;
  };
  dryRun: boolean;
}

export interface GhostDetail {
  workspace: string;
  campaign: string;
  campaignId: string;
  step: number;
  variant: number;
  variantLabel: string;
  cm: string | null;
  killedAt: string;
  detectedAt: string;
}

export interface RunSummary {
  timestamp: string;
  workspacesProcessed: number;
  campaignsEvaluated: number;
  variantsDisabled: number;
  variantsBlocked: number;
  variantsKillsPaused: number;
  variantsWarned: number;
  errors: number;
  durationMs: number;
  rescanChecked: number;
  rescanReEnabled: number;
  rescanExpired: number;
  rescanCmOverride: number;
  leadsChecked: number;
  leadsCheckErrors: number;
  leadsWarnings: number;
  leadsExhausted: number;
  leadsRecovered: number;
  ghostReEnables: number;
  ghostDetails: GhostDetail[] | null;
  winnersDetected: number;
  warmLeadsSkipped: number;
  stepsFrozen: number;
  freezeReEnables: number;
  dryRun: boolean;
}

export interface DaySummary {
  date: string;
  disabled: number;
  blocked: number;
  warned: number;
  errors: number;
  runsCompleted: number;
}

// --- Observability layer types ---

export interface WorkspaceSnapshot {
  name: string;
  product: string;
  totalVariants: number;
  activeVariants: number;
  disabledVariants: number;
  aboveThreshold: number;
}

export interface CmSnapshot {
  totalVariants: number;
  activeVariants: number;
  disabledVariants: number;
  aboveThreshold: number;
}

export interface CampaignHealthEntry {
  campaignId: string;
  campaignName: string;
  workspaceId: string;
  workspaceName: string;
  cm: string | null;
  totalVariants: number;
  activeVariants: number;
  disabledVariants: number;
  aboveThreshold: number;
  healthPct: number;
}

export interface DailySnapshot {
  date: string;
  capturedAt: string;
  totalCampaigns: number;
  totalSteps: number;
  totalVariants: number;
  activeVariants: number;
  disabledVariants: number;
  aboveThreshold: number;
  actionsToday: {
    disabled: number;
    blocked: number;
    warned: number;
    reEnabled: number;
    expired: number;
    cmOverride: number;
  };
  byWorkspace: Record<string, WorkspaceSnapshot>;
  byCm: Record<string, CmSnapshot>;
  campaignHealth: CampaignHealthEntry[];
}

export interface BaselineSnapshot extends DailySnapshot {
  type: 'baseline';
  note: string;
}

// --- Warning detail for dashboard APPROACHING items ---

export interface WarningDetail {
  campaignId: string;
  campaignName: string;
  workspaceId: string;
  workspaceName: string;
  stepIndex: number;
  variantIndex: number;
  variantLabel: string;
  sent: number;
  threshold: number;
  pctConsumed: number;
  opportunities: number;
  cm: string | null;
  product: Product;
  isOff: boolean;
}

// --- Campaign result (returned from processWithConcurrency callback) ---

export interface CampaignResult {
  /** Whether the campaign was evaluated (false if skipped by pilot filter) */
  evaluated: boolean;
  /** CM name for this campaign (needed for snapshot per-CM tally) */
  cmName: string | null;
  /** Number of successful kills executed */
  kills: number;
  /** Blocked audit entries (last-variant blocks + KILLS_ENABLED=false blocks) */
  blocked: AuditEntry[];
  /** Confirmed kill audit entries (for permanent DISABLED dashboard items) */
  confirmedKills: AuditEntry[];
  /** Dry-run kill audit entries (for per-CM dashboard review) */
  dryRunKills: AuditEntry[];
  /** Number of variants warned */
  warnings: number;
  /** Warning detail entries for dashboard APPROACHING items */
  warningDetails: WarningDetail[];
  /** Number of variants deferred (kill cap reached) */
  deferred: number;
  /** Number of variants with kills paused (KILLS_ENABLED=false) */
  killsPaused: number;
  /** Number of errors during processing */
  errors: number;
  /** Winner entries for this campaign (all qualifying variants, for dashboard) */
  winners: WinnerEntry[];
  /** Number of newly detected winners (not previously deduped) */
  winnersDetected: number;
  /** Leads check candidate for Phase 3 */
  leadsCandidate: LeadsCheckCandidate | null;
  /** Campaign-level snapshot data for daily snapshot aggregation */
  snapshot: {
    totalVariants: number;
    activeVariants: number;
    disabledVariants: number;
    aboveThreshold: number;
    steps: number;
    health: CampaignHealthEntry;
  } | null;
  /** Frozen steps (uniform underperformance detected — all variants equally bad) */
  frozenSteps: Array<{
    stepIndex: number;
    totalVariantCount: number;
    evaluatedVariantCount: number;
    reenabledVariants: number[];
    avgReplyRate: number;
    totalSent: number;
    totalOpps: number;
  }>;
}

// --- Dashboard state types ---

export type DashboardItemType = 'APPROACHING' | 'BLOCKED' | 'DISABLED' | 'DRY_RUN_KILL' | 'LEADS_EXHAUSTED' | 'LEADS_WARNING' | 'SEND_VOLUME_ANOMALY' | 'STEP_FROZEN' | 'WINNING';
export type DashboardSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface DashboardItem {
  item_type: DashboardItemType;
  severity: DashboardSeverity;
  cm: string;
  campaign_id: string;
  campaign_name: string;
  workspace_id: string;
  workspace_name: string;
  step: number | null;
  variant: number | null;
  variant_label: string | null;
  context: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  last_scan_at: string;
}

export interface ResolutionLogEntry {
  item_type: DashboardItemType;
  cm: string;
  campaign_id: string;
  campaign_name: string;
  workspace_id: string;
  step: number | null;
  variant: number | null;
  created_at: string;
  resolved_at: string;
  resolution_scan_id: string;
}

// --- Self-audit types (Phase 7) ---

export type AuditVerdict = 'GREEN' | 'YELLOW' | 'RED';
export type AuditCheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export type AuditCheckSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface AuditCheckResult {
  name: string;
  status: AuditCheckStatus;
  expected: string;
  actual: string;
  detail: string | null;
  severity: AuditCheckSeverity;
}

export interface AuditConfigSnapshot {
  pilot_cms: string[];
  dry_run_cms: string[];
  workspace_count: number;
  max_kills_per_run: number;
  kills_enabled: boolean;
}

export interface KvSummary {
  rescan_keys: number;
  exempt_keys: number;
  ghost_notified_keys: number;
  kill_keys: number;
  winner_notified_keys: number;
  step_frozen_keys: number;
}

export interface TrailingAvg {
  campaigns_evaluated: number;
  variants_disabled: number;
  variants_blocked: number;
  errors: number;
  run_count: number;
  config_changed: boolean;
}

export interface AuditResult {
  run_timestamp: string;
  worker_version: string;
  verdict: AuditVerdict;
  checks_total: number;
  checks_passed: number;
  checks_failed: number;
  checks_warned: number;
  checks_skipped: number;
  kills: number;
  blocks: number;
  winners: number;
  errors: number;
  ghosts: number;
  campaigns_evaluated: number;
  workspaces_processed: number;
  duration_ms: number;
  delta_kills: number | null;
  delta_blocks: number | null;
  delta_winners: number | null;
  delta_errors: number | null;
  delta_campaigns: number | null;
  check_results: AuditCheckResult[];
  config_snapshot: AuditConfigSnapshot;
  kv_summary: KvSummary | null;
  trailing_avg: TrailingAvg | null;
  audit_duration_ms: number;
}
