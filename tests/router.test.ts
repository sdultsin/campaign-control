import { describe, it, expect } from 'vitest';
import { resolveCmName, isPilotCampaign, isExcludedFromWorkspace } from '../src/router';
import type { WorkspaceConfig } from '../src/config';

describe('resolveCmName', () => {
  it('dedicated workspace falls back to defaultCm when no CM tag in name', () => {
    const config: WorkspaceConfig = { id: 'equinox', name: 'Equinox', product: 'FUNDING', defaultCm: 'LEO' };
    expect(resolveCmName(config, 'Regular Campaign')).toBe('LEO');
    expect(resolveCmName(config, "General (Ben's leads) RG2848")).toBe('LEO');
    expect(resolveCmName(config, 'HVAC (test) RG2900')).toBe('LEO');
    expect(resolveCmName(config, 'Construction (new batch) RG3001')).toBe('LEO');
    expect(resolveCmName(config, 'No Show Follow Up')).toBe('LEO');
  });

  it('dedicated workspace: explicit CM tag in name overrides defaultCm', () => {
    // Overflow scenario: Outlook 3 is LEO's workspace but Marcos runs
    // campaigns there, and Outlook 1 is IDO's workspace but Andres/Leo
    // run campaigns there. The paren tag must win.
    const ido: WorkspaceConfig = { id: 'outlook-1', name: 'Outlook 1', product: 'FUNDING', defaultCm: 'IDO' };
    expect(resolveCmName(ido, 'ON - Pair 22 - Populane - Bar (LEO)')).toBe('LEO');
    expect(resolveCmName(ido, 'ON - General 5 A Pair 17 (ANDRES) Y')).toBe('ANDRES');
  });

  it('dedicated workspace: unknown paren token falls back to defaultCm', () => {
    // SAMUEL was offboarded and is no longer in CM_CHANNEL_MAP, so
    // "(SAMUEL)" does not match and the workspace owner wins.
    const ido: WorkspaceConfig = { id: 'outlook-1', name: 'Outlook 1', product: 'FUNDING', defaultCm: 'IDO' };
    expect(resolveCmName(ido, 'ON - PAIR 1 - RETAIL (SAMUEL)')).toBe('IDO');
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
