import { describe, it, expect } from 'vitest';
import { evaluateLeadDepletion } from '../src/leads-monitor';

describe('evaluateLeadDepletion', () => {
  it('returns SKIPPED when totalLeads is 0', () => {
    expect(evaluateLeadDepletion(0, 0).status).toBe('SKIPPED');
  });

  it('returns EXHAUSTED when uncontacted equals 100 (inclusive floor)', () => {
    expect(evaluateLeadDepletion(100, 50000).status).toBe('EXHAUSTED');
  });

  it('returns EXHAUSTED when uncontacted is below 100', () => {
    expect(evaluateLeadDepletion(50, 50000).status).toBe('EXHAUSTED');
  });

  it('returns WARNING when uncontacted is 101 (just above EXHAUSTED)', () => {
    expect(evaluateLeadDepletion(101, 50000).status).toBe('WARNING');
  });

  it('returns WARNING when uncontacted is just below 10000', () => {
    expect(evaluateLeadDepletion(9999, 50000).status).toBe('WARNING');
  });

  it('returns HEALTHY when uncontacted equals 10000 (warning threshold is strict <)', () => {
    expect(evaluateLeadDepletion(10000, 50000).status).toBe('HEALTHY');
  });

  it('returns HEALTHY when uncontacted is well above warning threshold', () => {
    expect(evaluateLeadDepletion(20000, 50000).status).toBe('HEALTHY');
  });
});
