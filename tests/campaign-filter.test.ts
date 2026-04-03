import { describe, it, expect } from 'vitest';
import { isOldCampaign, isOffCampaign, isWarmLeadsCampaign, hasDataIntegrityIssue } from '../src/campaign-filter';

describe('isOldCampaign', () => {
  it('skips campaign with OLD prefix', () => {
    expect(isOldCampaign('OLD Q1 Funding')).toBe(true);
  });

  it('skips campaign with emoji + OLD prefix', () => {
    expect(isOldCampaign('\u{1F534} OLD Campaign')).toBe(true);
  });

  it('passes normal campaign', () => {
    expect(isOldCampaign('Q2 Growth (LEO)')).toBe(false);
  });

  it('does not match OLD in middle of name', () => {
    expect(isOldCampaign('My OLD Campaign')).toBe(false);
  });
});

describe('isWarmLeadsCampaign', () => {
  it('excludes campaign with < 5000 contacted', () => {
    expect(isWarmLeadsCampaign(500)).toBe(true);
  });

  it('passes campaign with >= 5000 contacted', () => {
    expect(isWarmLeadsCampaign(5000)).toBe(false);
  });
});

describe('hasDataIntegrityIssue', () => {
  it('flags when sent exceeds contacted by >10%', () => {
    // 5500 / 5000 = 1.1 exactly, not > 1.1 -> no issue
    expect(hasDataIntegrityIssue(5500, 5000)).toBe(false);
    // 5501 > 5000 * 1.1 = 5500 -> issue
    expect(hasDataIntegrityIssue(5501, 5000)).toBe(true);
  });

  it('passes when contacted is 0', () => {
    expect(hasDataIntegrityIssue(5000, 0)).toBe(false);
  });
});

describe('isOffCampaign', () => {
  it('matches OFF-prefixed campaigns', () => {
    expect(isOffCampaign('OFF Q1 Test')).toBe(true);
    expect(isOffCampaign('OFF-Campaign')).toBe(true);
  });

  it('does not match OFFER or similar', () => {
    expect(isOffCampaign('OFFER Campaign')).toBe(false);
  });
});
