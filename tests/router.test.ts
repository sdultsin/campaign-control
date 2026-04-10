import { describe, it, expect } from 'vitest';
import { resolveCmName, isPilotCampaign, isExcludedFromWorkspace } from '../src/router';
import type { WorkspaceConfig } from '../src/config';

describe('resolveCmName', () => {
  it('dedicated workspace returns defaultCm regardless of campaign name', () => {
    const config: WorkspaceConfig = { id: 'equinox', name: 'Equinox', product: 'FUNDING', defaultCm: 'LEO' };
    expect(resolveCmName(config, 'Regular Campaign')).toBe('LEO');
    expect(resolveCmName(config, "General (Ben's leads) RG2848")).toBe('LEO');
    expect(resolveCmName(config, 'HVAC (test) RG2900')).toBe('LEO');
    expect(resolveCmName(config, 'Construction (new batch) RG3001')).toBe('LEO');
    expect(resolveCmName(config, 'No Show Follow Up')).toBe('LEO');
  });

  it('shared workspace resolves valid CM from parentheses', () => {
    const config: WorkspaceConfig = { id: 'the-eagles', name: 'The Eagles', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'General (IDO) RG3100')).toBe('IDO');
  });

  it('shared workspace with non-CM parens falls through to suffix', () => {
    const config: WorkspaceConfig = { id: 'the-eagles', name: 'The Eagles', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'General (random text) - ALEX')).toBe('ALEX');
  });

  it('shared workspace with no CM match returns null', () => {
    const config: WorkspaceConfig = { id: 'the-eagles', name: 'The Eagles', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'General (random text) RG3200')).toBeNull();
  });

  it('filters out (copy) from parentheses matches', () => {
    const config: WorkspaceConfig = { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'Campaign (copy) (ALEX)')).toBe('ALEX');
  });
});

describe('isExcludedFromWorkspace', () => {
  it('does not exclude any CMs (no current exclusions configured)', () => {
    expect(isExcludedFromWorkspace('the-eagles', 'LEO')).toBe(false);
    expect(isExcludedFromWorkspace('the-eagles', 'IDO')).toBe(false);
  });
});

describe('isPilotCampaign', () => {
  it('returns true for pilot CM', () => {
    expect(isPilotCampaign('LEO')).toBe(true);
  });

  it('returns false for non-pilot CM', () => {
    expect(isPilotCampaign('UNKNOWN_CM')).toBe(false);
  });

  it('returns false for null CM', () => {
    expect(isPilotCampaign(null)).toBe(false);
  });
});
