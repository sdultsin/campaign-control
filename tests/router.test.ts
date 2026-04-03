import { describe, it, expect } from 'vitest';
import { resolveCmName, isPilotCampaign, isExcludedFromWorkspace } from '../src/router';
import type { WorkspaceConfig } from '../src/config';

describe('resolveCmName', () => {
  it('resolves CM from parentheses in campaign name', () => {
    const config: WorkspaceConfig = { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'Q2 Growth (LEO)')).toBe('LEO');
  });

  it('uses defaultCm for dedicated workspace', () => {
    const config: WorkspaceConfig = { id: 'equinox', name: 'Equinox', product: 'FUNDING', defaultCm: 'LEO' };
    expect(resolveCmName(config, 'Regular Campaign')).toBe('LEO');
  });

  it('returns null for shared workspace with no CM tag', () => {
    const config: WorkspaceConfig = { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'Unknown Campaign')).toBeNull();
  });

  it('skips NO SHOW campaigns in dedicated workspace', () => {
    const config: WorkspaceConfig = { id: 'equinox', name: 'Equinox', product: 'FUNDING', defaultCm: 'LEO' };
    expect(resolveCmName(config, 'No Show Follow Up')).toBeNull();
  });

  it('filters out (copy) from parentheses matches', () => {
    const config: WorkspaceConfig = { id: 'renaissance-4', name: 'Renaissance 4', product: 'FUNDING', defaultCm: null };
    expect(resolveCmName(config, 'Campaign (copy) (ALEX)')).toBe('ALEX');
  });
});

describe('isExcludedFromWorkspace', () => {
  it('excludes SAMUEL from the-eagles', () => {
    expect(isExcludedFromWorkspace('the-eagles', 'SAMUEL')).toBe(true);
  });

  it('does not exclude other CMs from the-eagles', () => {
    expect(isExcludedFromWorkspace('the-eagles', 'LEO')).toBe(false);
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
