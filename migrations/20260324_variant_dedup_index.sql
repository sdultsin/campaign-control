-- Migration: Add variant to dashboard_items dedup index
-- Date: 2026-03-24
-- Spec: specs/cc-dashboard-variant-dedup-fix.md
--
-- MUST run BEFORE deploying worker code.
-- Old index rejects 2+ winner rows per step. New index allows them when variants differ.

DROP INDEX IF EXISTS idx_dashboard_items_dedup;

CREATE UNIQUE INDEX idx_dashboard_items_dedup
  ON dashboard_items (cm, campaign_id, item_type, COALESCE(step, -1), COALESCE(variant, -1))
  WHERE (resolved_at IS NULL);
