import { describe, it, expect, vi, afterEach } from 'vitest';
import { InstantlyDirectApi } from '../src/instantly-direct';
import type { StepAnalytics } from '../src/types';

// Minimal key map matching a workspace config entry.
// "renaissance-3" is in WORKSPACE_CONFIGS with name "Renaissance 3".
const KEY_MAP_JSON = JSON.stringify({ 'renaissance-3': 'test-api-key' });

function makeStepAnalytics(rows: Array<{ step: string; variant: string; sent: number }>): StepAnalytics[] {
  return rows.map((r) => ({
    step: r.step,
    variant: r.variant,
    sent: r.sent,
    replies: 0,
    unique_replies: 0,
    opportunities: 0,
    unique_opportunities: 0,
  }));
}

function mockFetchWithAggregateSent(sent: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [{ sent }] }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkAnalyticsFreshness', () => {
  it('stale case: stepTotal=800, aggregateTotal=2500, ratio=0.32 -> isStale=true', async () => {
    mockFetchWithAggregateSent(2500);
    const api = new InstantlyDirectApi(KEY_MAP_JSON);
    const stepAnalytics = makeStepAnalytics([
      { step: '0', variant: '0', sent: 400 },
      { step: '0', variant: '1', sent: 400 },
    ]);
    const result = await api.checkAnalyticsFreshness('renaissance-3', 'campaign-abc', stepAnalytics);
    expect(result.isStale).toBe(true);
    expect(result.stepTotal).toBe(800);
    expect(result.aggregateTotal).toBe(2500);
    // ratio = 800 / 2500 = 0.32
    expect(result.ratio).toBeCloseTo(0.32, 5);
  });

  it('fresh case: stepTotal=2200, aggregateTotal=2500, ratio=0.88 -> isStale=false', async () => {
    mockFetchWithAggregateSent(2500);
    const api = new InstantlyDirectApi(KEY_MAP_JSON);
    const stepAnalytics = makeStepAnalytics([
      { step: '0', variant: '0', sent: 1100 },
      { step: '0', variant: '1', sent: 1100 },
    ]);
    const result = await api.checkAnalyticsFreshness('renaissance-3', 'campaign-abc', stepAnalytics);
    expect(result.isStale).toBe(false);
    expect(result.stepTotal).toBe(2200);
    expect(result.aggregateTotal).toBe(2500);
    // ratio = 2200 / 2500 = 0.88
    expect(result.ratio).toBeCloseTo(0.88, 5);
  });

  it('exempt (low aggregate) case: aggregateTotal=1500 (below 2000 min) -> isStale=false regardless of ratio', async () => {
    // Even though stepTotal=0 would give ratio=0, aggregate below min -> exempt
    mockFetchWithAggregateSent(1500);
    const api = new InstantlyDirectApi(KEY_MAP_JSON);
    const stepAnalytics = makeStepAnalytics([]);
    const result = await api.checkAnalyticsFreshness('renaissance-3', 'campaign-abc', stepAnalytics);
    expect(result.isStale).toBe(false);
    expect(result.aggregateTotal).toBe(1500);
    // ratio forced to 1 (exempt)
    expect(result.ratio).toBe(1);
  });

  it('API error fallback: fetch throws -> returns { isStale: false, stepTotal: 0, aggregateTotal: 0, ratio: 1 }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );
    const api = new InstantlyDirectApi(KEY_MAP_JSON);
    const stepAnalytics = makeStepAnalytics([
      { step: '0', variant: '0', sent: 500 },
    ]);
    const result = await api.checkAnalyticsFreshness('renaissance-3', 'campaign-abc', stepAnalytics);
    expect(result.isStale).toBe(false);
    expect(result.stepTotal).toBe(0);
    expect(result.aggregateTotal).toBe(0);
    expect(result.ratio).toBe(1);
  });
});
