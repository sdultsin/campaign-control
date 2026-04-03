import { describe, it, expect } from 'vitest';
import { evaluateLeadDepletion } from '../src/leads-monitor';

describe('evaluateLeadDepletion', () => {
  it('returns EXHAUSTED when 0 leads remaining', () => {
    const result = evaluateLeadDepletion(0, 10000);
    expect(result.status).toBe('EXHAUSTED');
  });

  it('returns WARNING when leads below warning threshold', () => {
    // LEADS_WARNING_THRESHOLD = 5000, so 3000 < 5000 -> WARNING
    const result = evaluateLeadDepletion(3000, 50000);
    expect(result.status).toBe('WARNING');
  });

  it('returns HEALTHY when leads above warning threshold', () => {
    const result = evaluateLeadDepletion(10000, 50000);
    expect(result.status).toBe('HEALTHY');
  });
});
