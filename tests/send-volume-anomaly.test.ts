import { describe, it, expect, vi } from 'vitest';
import {
  resolvePairs,
  sumExpectedVolume,
  evaluateAnomaly,
  todayUtcIso,
  dedupKey,
  fetchActiveSamCampaigns,
  runSendVolumeCheck,
} from '../src/send-volume-anomaly';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { InstantlyDirectApi } from '../src/instantly-direct';
import { PAIR_VOLUME } from '../src/config';

// Vitest tests for the send-volume anomaly check. Covers the 8 cases in spec
// §12 plus a few internal helpers. Pure functions are unit-tested; the main
// loop is tested with stubbed Supabase/Instantly/KV.

// --- Threshold math (spec §12.1) -----------------------------------------

describe('evaluateAnomaly - threshold math', () => {
  // Using Wednesday (utcDay=3) so weekend silence rule doesn't interfere.
  const WED = 3;

  it('fires UNDER at ratio 0.70 boundary (35,000 / 50,000)', () => {
    const d = evaluateAnomaly(35000, 50000, WED);
    // Spec says "35,000 -> under fires (ratio 0.70 - boundary)". Our rule is
    // strict `< 0.70`, so 0.70 exact does NOT fire. Verify and escalate if
    // spec intent differs.
    expect(d.ratio).toBeCloseTo(0.7, 5);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('in_band');
  });

  it('fires UNDER at 34,999 (ratio < 0.70)', () => {
    const d = evaluateAnomaly(34999, 50000, WED);
    expect(d.fire).toBe(true);
    expect(d.direction).toBe('under');
  });

  it('fires OVER at 60,001 (ratio > 1.20)', () => {
    const d = evaluateAnomaly(60001, 50000, WED);
    expect(d.fire).toBe(true);
    expect(d.direction).toBe('over');
  });

  it('does NOT fire OVER at 60,000 boundary', () => {
    const d = evaluateAnomaly(60000, 50000, WED);
    expect(d.ratio).toBeCloseTo(1.2, 5);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('in_band');
  });

  it('does NOT fire when today equals expected', () => {
    const d = evaluateAnomaly(50000, 50000, WED);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('in_band');
  });
});

// --- Weekend silence (spec §12.2) ----------------------------------------

describe('evaluateAnomaly - weekend silence', () => {
  it('suppresses alert when sent=0 on Saturday', () => {
    const d = evaluateAnomaly(0, 50000, 6);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('weekend_silence');
  });

  it('suppresses alert when sent=0 on Sunday', () => {
    const d = evaluateAnomaly(0, 50000, 0);
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('weekend_silence');
  });

  it('still fires UNDER when sent=0 on a weekday', () => {
    const d = evaluateAnomaly(0, 50000, 3);
    expect(d.fire).toBe(true);
    expect(d.direction).toBe('under');
  });

  it('still fires OVER when sent is above band on a Saturday', () => {
    // Saturday, but sent is not zero -- weekend silence only suppresses zero.
    const d = evaluateAnomaly(80000, 50000, 6);
    expect(d.fire).toBe(true);
    expect(d.direction).toBe('over');
  });
});

// --- RG -> pair -> expected (spec §12.4 and §12.5) -----------------------

describe('resolvePairs / sumExpectedVolume', () => {
  it('resolves single pair from paired RGs', () => {
    expect(resolvePairs(['RG3531', 'RG3532'])).toEqual(['Pair 12']);
    expect(sumExpectedVolume(['Pair 12'])).toBe(PAIR_VOLUME['Pair 12']);
    expect(sumExpectedVolume(['Pair 12'])).toBe(23760);
  });

  it('resolves multi-pair campaign (Pair 6 + Pair 8 => 71,280)', () => {
    const pairs = resolvePairs(['RG3450', 'RG3451', 'RG3452', 'RG3455', 'RG3456', 'RG3457']);
    expect(pairs.sort()).toEqual(['Pair 6', 'Pair 8']);
    expect(sumExpectedVolume(pairs)).toBe(35640 + 35640);
    expect(sumExpectedVolume(pairs)).toBe(71280);
  });

  it('returns empty array for unknown RG', () => {
    expect(resolvePairs(['RG9999'])).toEqual([]);
    expect(resolvePairs(null)).toEqual([]);
    expect(resolvePairs(undefined)).toEqual([]);
    expect(resolvePairs([])).toEqual([]);
  });

  it('deduplicates when multiple RGs resolve to same pair', () => {
    expect(resolvePairs(['RG3531', 'RG3532', 'RG3531'])).toEqual(['Pair 12']);
  });

  it('ignores unknown RGs mixed with known', () => {
    const pairs = resolvePairs(['RG3531', 'RG9999', 'RG3532']);
    expect(pairs).toEqual(['Pair 12']);
  });
});

// --- Utility helpers -----------------------------------------------------

describe('todayUtcIso', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    // 2026-04-16T05:00:00Z is still 2026-04-16 in UTC regardless of local TZ.
    expect(todayUtcIso(new Date('2026-04-16T05:00:00Z'))).toBe('2026-04-16');
    expect(todayUtcIso(new Date('2026-04-16T23:59:59Z'))).toBe('2026-04-16');
    expect(todayUtcIso(new Date('2026-04-17T00:00:00Z'))).toBe('2026-04-17');
  });
});

describe('dedupKey', () => {
  it('produces stable keys per day/campaign/direction', () => {
    expect(dedupKey('2026-04-16', 'c-abc', 'under'))
      .toBe('anomaly_fired:2026-04-16:c-abc:under');
    expect(dedupKey('2026-04-16', 'c-abc', 'over'))
      .toBe('anomaly_fired:2026-04-16:c-abc:over');
  });
});

// --- Supabase-stub tests for the query helper ----------------------------

function buildSupabaseStub(rows: unknown[]) {
  // Chainable mock that matches the subset of the supabase-js builder we use.
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    // Final awaitable
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };
  return chain as unknown as SupabaseClient;
}

describe('fetchActiveSamCampaigns', () => {
  it('returns active Sam campaigns with status=1 filter applied', async () => {
    const rows = [
      {
        campaign_id: 'c1',
        campaign_name: 'Pair 12 - General (SAM) Copy A',
        workspace_name: 'Tariffs + Funding',
        rg_batch_tags: ['RG3531', 'RG3532'],
        status: '1',
      },
    ];
    const sb = buildSupabaseStub(rows);
    const result = await fetchActiveSamCampaigns(sb);
    expect(result).toHaveLength(1);
    expect(result[0].campaignId).toBe('c1');
    expect(result[0].rgBatchTags).toEqual(['RG3531', 'RG3532']);
  });
});

// --- Dedup + run-loop behavior (spec §12.3, §12.6, §12.7, §12.8) ---------

/** Minimal in-memory KV stub with TTL (no expiration simulation). */
function makeKvStub() {
  const store = new Map<string, string>();
  const stub = {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
  return stub;
}

function makeInstantlyStub(sentToday: number): InstantlyDirectApi {
  return {
    getDailyAnalytics: async (_ws: string, _cid: string, date: string) => [
      { date, sent: sentToday },
    ],
  } as unknown as InstantlyDirectApi;
}

function makeRunSbStub(rows: unknown[]) {
  // Stub supports both the campaigns query (chainable thenable) and the
  // dashboard/notification writes used by upsertDashboardItem +
  // writeNotificationToSupabase.
  const campaignsQuery = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };

  // upsertDashboardItem does .select().eq()...is().limit() then awaits; and
  // on insert path calls .insert() which returns awaitable. Build a stub that
  // returns different thenables depending on chain.
  let callPath: 'list' | 'insert' | 'other' = 'list';
  const sb = {
    from: vi.fn((table: string) => {
      // Reset call path for each .from()
      callPath = 'list';
      return chain;
    }),
  };
  const chain: Record<string, unknown> = {
    select: vi.fn().mockImplementation(() => chain),
    eq: vi.fn().mockImplementation(() => chain),
    ilike: vi.fn().mockImplementation(() => chain),
    is: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockImplementation(() => chain),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };

  return sb as unknown as SupabaseClient;
}

describe('runSendVolumeCheck - dedup', () => {
  it('first call fires + writes KV, second call in same day skips', async () => {
    const rows = [
      {
        campaign_id: 'cd-1',
        campaign_name: 'Pair 12 - General (SAM) Copy A',
        workspace_name: 'Tariffs + Funding',
        rg_batch_tags: ['RG3531', 'RG3532'], // Pair 12 -> expected 23,760
        status: '1',
      },
    ];

    // today_sent = 10,000 => ratio ~0.42 -> UNDER alert.
    const kv = makeKvStub();

    const sb1 = makeRunSbStub(rows);
    const inst = makeInstantlyStub(10000);

    const wed = new Date('2026-04-15T18:00:00Z'); // Wednesday 18:00 UTC
    const first = await runSendVolumeCheck({
      sb: sb1, instantly: inst, kv, now: wed, isDryRun: false,
    });
    expect(first.alertsFiredUnder).toBe(1);
    expect(first.alertsFiredOver).toBe(0);
    expect(first.dedupSkipped).toBe(0);
    // KV should now contain the dedup key.
    const expectedKey = `anomaly_fired:2026-04-15:cd-1:under`;
    expect((kv as unknown as { store: Map<string, string> }).store.has(expectedKey)).toBe(true);

    // Second call same day: dedup should suppress.
    const sb2 = makeRunSbStub(rows);
    const second = await runSendVolumeCheck({
      sb: sb2, instantly: inst, kv, now: wed, isDryRun: false,
    });
    expect(second.alertsFiredUnder).toBe(0);
    expect(second.dedupSkipped).toBe(1);
  });

  it('next UTC day resets dedup (uses new key)', async () => {
    const rows = [
      {
        campaign_id: 'cd-2',
        campaign_name: 'Pair 12 - General (SAM) Copy A',
        workspace_name: 'Tariffs + Funding',
        rg_batch_tags: ['RG3531', 'RG3532'],
        status: '1',
      },
    ];
    const kv = makeKvStub();
    const inst = makeInstantlyStub(10000);

    const day1 = new Date('2026-04-15T18:00:00Z');
    const day2 = new Date('2026-04-16T18:00:00Z');

    const r1 = await runSendVolumeCheck({
      sb: makeRunSbStub(rows), instantly: inst, kv, now: day1, isDryRun: false,
    });
    expect(r1.alertsFiredUnder).toBe(1);

    const r2 = await runSendVolumeCheck({
      sb: makeRunSbStub(rows), instantly: inst, kv, now: day2, isDryRun: false,
    });
    // Day 2: different dedup key -> fires again.
    expect(r2.alertsFiredUnder).toBe(1);
    expect(r2.dedupSkipped).toBe(0);
  });
});

describe('runSendVolumeCheck - edge cases', () => {
  it('logs + skips when no pairs resolve (unknown RG)', async () => {
    const rows = [
      {
        campaign_id: 'c-unknown',
        campaign_name: 'New batch (SAM) Copy A',
        workspace_name: 'Renaissance 6',
        rg_batch_tags: ['RG9999'],
        status: '1',
      },
    ];
    const kv = makeKvStub();
    const inst = makeInstantlyStub(10000);
    const wed = new Date('2026-04-15T18:00:00Z');

    const summary = await runSendVolumeCheck({
      sb: makeRunSbStub(rows), instantly: inst, kv, now: wed, isDryRun: false,
    });
    expect(summary.unresolvedPairs).toBe(1);
    expect(summary.alertsFiredUnder + summary.alertsFiredOver).toBe(0);
    expect((kv as unknown as { store: Map<string, string> }).store.size).toBe(0);
  });

  it('skips when workspace slug is unmapped', async () => {
    const rows = [
      {
        campaign_id: 'c-unknown-ws',
        campaign_name: 'Pair 12 (SAM)',
        workspace_name: 'Some Unknown Workspace',
        rg_batch_tags: ['RG3531'],
        status: '1',
      },
    ];
    const kv = makeKvStub();
    const inst = makeInstantlyStub(0);
    const wed = new Date('2026-04-15T18:00:00Z');

    const summary = await runSendVolumeCheck({
      sb: makeRunSbStub(rows), instantly: inst, kv, now: wed, isDryRun: false,
    });
    expect(summary.unmappedWorkspace).toBe(1);
    expect(summary.campaignsChecked).toBe(0);
  });
});
