import { describe, it, expect } from 'vitest';
import { resolveThreshold, type ThresholdApi } from '../src/thresholds';
import { getStepMultiplier, OFF_CAMPAIGN_BUFFER } from '../src/config';

// Minimal KV stub - returns null for get (cache miss), no-op put
const stubKv = {
  get: async () => null,
  put: async () => {},
} as unknown as KVNamespace;

function makeApi(providerCode: number): ThresholdApi {
  return {
    listAccounts: async () => [{ email: 'test@example.com', provider_code: providerCode }],
    getAccount: async () => ({ provider_code: providerCode }),
  };
}

describe('resolveThreshold', () => {
  it('resolves SMTP campaign to 4500', async () => {
    const campaign = { id: 'c1', name: 'Test', status: 'active', sequences: [], email_tag_list: ['tag1'] };
    const threshold = await resolveThreshold('renaissance-1', campaign, makeApi(1), stubKv);
    expect(threshold).toBe(4500);
  });

  it('resolves Outlook campaign to 5000', async () => {
    const campaign = { id: 'c2', name: 'Test', status: 'active', sequences: [], email_tag_list: ['tag1'] };
    const threshold = await resolveThreshold('equinox', campaign, makeApi(3), stubKv);
    expect(threshold).toBe(5000);
  });

  it('resolves ERC product to 6000 regardless of provider', async () => {
    const campaign = { id: 'c3', name: 'ERC Test', status: 'active', sequences: [] };
    const threshold = await resolveThreshold('erc-1', campaign, makeApi(1), stubKv);
    expect(threshold).toBe(6000);
  });

  it('applies OFF buffer (1.2x) for OFF campaigns', async () => {
    const campaign = { id: 'c4', name: 'OFF Test', status: 'active', sequences: [], email_tag_list: ['tag1'] };
    const threshold = await resolveThreshold('renaissance-1', campaign, makeApi(1), stubKv, true);
    expect(threshold).toBe(Math.round(4500 * OFF_CAMPAIGN_BUFFER)); // 5400
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
    const campaign = { id: 'c5', name: 'Test', status: 'active', sequences: [], email_tag_list: ['tag1'] };
    // SMTP base = 4500, OFF buffer = 4500 * 1.2 = 5400, Step 2 (index 1) = 5400 * 1.3 = 7020
    const baseThreshold = await resolveThreshold('renaissance-1', campaign, makeApi(1), stubKv, true);
    const effective = Math.round(baseThreshold! * getStepMultiplier(1));
    expect(effective).toBe(7020);
  });
});
