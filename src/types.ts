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
  dailyLimit: number;
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
  DRY_RUN: string;
  CONCURRENCY_CAP: string;
  SLACK_BOT_TOKEN: string;
  SLACK_FALLBACK_CHANNEL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  KILLS_ENABLED: string;
  INSTANTLY_API_KEYS: string;  // JSON map: { "workspace-slug-or-name": "base64-api-key", ... }
  INSTANTLY_MODE: string; // "direct" | "mcp"
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

export interface AuditEntry {
  timestamp: string;
  action: 'DISABLED' | 'BLOCKED' | 'WARNING' | 'RE_ENABLED' | 'EXPIRED' | 'CM_OVERRIDE' | 'DEFERRED' | 'MANUAL_REVERT' | 'GHOST_REENABLE';
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
  /** Dry-run kill audit entries (for per-CM dashboard review) */
  dryRunKills: AuditEntry[];
  /** Number of variants warned */
  warnings: number;
  /** Number of variants deferred (kill cap reached) */
  deferred: number;
  /** Number of variants with kills paused (KILLS_ENABLED=false) */
  killsPaused: number;
  /** Number of errors during processing */
  errors: number;
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
}

// --- Dashboard state types ---

export type DashboardItemType = 'BLOCKED' | 'DISABLED' | 'LEADS_EXHAUSTED' | 'LEADS_WARNING';
export type DashboardSeverity = 'CRITICAL' | 'WARNING';

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
