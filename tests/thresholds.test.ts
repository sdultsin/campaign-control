import { describe, it, expect } from 'vitest';
import { resolveThreshold } from '../src/thresholds';
import { getStepMultiplier, OFF_CAMPAIGN_BUFFER } from '../src/config';

// Minimal KV stub - returns null for get (cache miss), no-op put
const stubKv = {
  get: async () => null,
  put: async () => {},
} as unknown as KVNamespace;

describe('resolveThreshold', () => {
  it('resolves google infra to 3800', async () => {
    const threshold = await resolveThreshold('renaissance-1', 'c1', 'google', stubKv);
    expect(threshold).toBe(3800);
  });

  it('resolves outlook infra to 5000', async () => {
    const threshold = await resolveThreshold('equinox', 'c2', 'outlook', stubKv);
    expect(threshold).toBe(5000);
  });

  it('resolves null infra to default 4000', async () => {
    const threshold = await resolveThreshold('renaissance-1', 'c3', null, stubKv);
    expect(threshold).toBe(4000);
  });

  it('resolves ERC product to 6000 regardless of infra', async () => {
    const threshold = await resolveThreshold('erc-2', 'c4', 'google', stubKv);
    expect(threshold).toBe(6000);
  });

  it('applies OFF buffer (1.2x) for OFF campaigns', async () => {
    const threshold = await resolveThreshold('renaissance-1', 'c5', 'google', stubKv, true);
    expect(threshold).toBe(Math.round(3800 * OFF_CAMPAIGN_BUFFER)); // 4560
  });

  it('uses KV cache when available', async () => {
    const cachedKv = {
      get: async () => '4500',
      put: async () => {},
    } as unknown as KVNamespace;
    const threshold = await resolveThreshold('renaissance-1', 'c6', null, cachedKv);
    expect(threshold).toBe(4500);
  });
});

describe('getStepMultiplier', () => {
  it('returns 1.6x for Step 3 (index 2)', () => {
    expect(getStepMultiplier(2)).toBe(1.6);
  });

  it('caps at 2.0x for Step 5+ (index 4+)', () => {
    expect(getStepMultiplier(4)).toBe(2.0);
    expect(getStepMultiplier(10)).toBe(2.0);
  });
});

describe('threshold stacking', () => {
  it('OFF + Step 2 multipliers stack correctly', async () => {
    // Google base = 3800, OFF buffer = 3800 * 1.2 = 4560, Step 2 (index 1) = 4560 * 1.3 = 5928
    const baseThreshold = await resolveThreshold('renaissance-1', 'c7', 'google', stubKv, true);
    const effective = Math.round(baseThreshold! * getStepMultiplier(1));
    expect(effective).toBe(5928);
  });
});
