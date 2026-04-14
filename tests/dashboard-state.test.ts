import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../src/types';
import { buildDashboardState } from '../src/dashboard-state';
import { resolveStaleItems, upsertDashboardItem } from '../src/supabase';

vi.mock('../src/supabase', () => ({
  upsertDashboardItem: vi.fn().mockResolvedValue(undefined),
  resolveStaleItems: vi.fn().mockResolvedValue(0),
}));

function makeKillAudit(campaignId: string, variant: number): AuditEntry {
  return {
    timestamp: '2026-04-14T23:10:27.616Z',
    action: 'DISABLED',
    workspace: 'The Dyad',
    workspaceId: 'the-dyad',
    campaign: 'ON - Pair 8 - Physical Therapy (CARLOS)',
    campaignId,
    step: 2,
    variant,
    variantLabel: String.fromCharCode(65 + variant),
    cm: 'CARLOS',
    product: 'FUNDING',
    trigger: {
      sent: 11474,
      opportunities: 3,
      ratio: '3824.7',
      threshold: 4940,
      effective_threshold: 4940,
      rule: 'Ratio recovered',
    },
    safety: {
      survivingVariants: 1,
      notification: null,
    },
    dryRun: false,
  };
}

describe('buildDashboardState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes DISABLED for confirmed kills and DRY_RUN_KILL for dry-run review items', async () => {
    const sb = {} as never;
    const confirmedKill = makeKillAudit('campaign-confirmed', 0);
    const dryRunKill = { ...makeKillAudit('campaign-dry-run', 1), dryRun: true };

    await buildDashboardState(
      sb,
      'scan-1',
      [],
      [],
      [],
      [confirmedKill],
      [dryRunKill],
    );

    expect(upsertDashboardItem).toHaveBeenCalledWith(
      sb,
      expect.objectContaining({
        item_type: 'DISABLED',
        campaign_id: 'campaign-confirmed',
        variant: 0,
      }),
    );
    expect(upsertDashboardItem).toHaveBeenCalledWith(
      sb,
      expect.objectContaining({
        item_type: 'DRY_RUN_KILL',
        campaign_id: 'campaign-dry-run',
        variant: 1,
      }),
    );
  });

  it('drops DRY_RUN_KILL from activeKeys once the issue no longer persists', async () => {
    const sb = {} as never;

    await buildDashboardState(
      sb,
      'scan-2',
      [],
      [],
      [],
      [],
      [],
    );

    const carlosCall = vi
      .mocked(resolveStaleItems)
      .mock.calls.find(([, cm]) => cm === 'CARLOS');

    expect(carlosCall).toBeDefined();
    expect(carlosCall?.[2]).toBeInstanceOf(Set);
    expect((carlosCall?.[2] as Set<string>).size).toBe(0);
  });
});
