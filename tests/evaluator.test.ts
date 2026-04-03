import { describe, it, expect } from 'vitest';
import { evaluateVariant, safetyCheck, evaluateStep, checkVariantWarnings, evaluateWinner } from '../src/evaluator';
import type { Step, StepAnalytics } from '../src/types';

describe('evaluateVariant', () => {
  it('kills variant with 0 opps at threshold', () => {
    const result = evaluateVariant(5000, 0, 5000);
    expect(result.action).toBe('KILL_CANDIDATE');
  });

  it('spares variant below threshold', () => {
    const result = evaluateVariant(3000, 0, 5000);
    expect(result.action).toBe('SKIP');
  });

  it('gives OPP_RUNWAY_MULTIPLIER runway to variant with opps', () => {
    // 5000 sent, 1 opp. Ratio = 5000. Extended threshold = 5000 * 1.1 = 5500.
    // 5000 <= 5500 -> KEEP
    const result = evaluateVariant(5000, 1, 5000);
    expect(result.action).toBe('KEEP');
  });

  it('kills variant with opps when ratio exceeds extended threshold', () => {
    // 6000 sent, 1 opp. Ratio = 6000. Extended threshold = 5000 * 1.1 = 5500.
    // 6000 > 5500 -> KILL_CANDIDATE
    const result = evaluateVariant(6000, 1, 5000);
    expect(result.action).toBe('KILL_CANDIDATE');
  });
});

describe('evaluateStep', () => {
  it('blocks last active variant instead of killing', () => {
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a', v_disabled: true },
        { subject: 'B', body: 'b' },
      ],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '1', sent: 5000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const result = evaluateStep(analytics, step, 0, 5000);
    expect(result.kills).toHaveLength(0);
    expect(result.blocked).not.toBeNull();
    expect(result.blocked!.variantIndex).toBe(1);
    expect(result.blocked!.notification).toBe('LAST_VARIANT');
  });

  it('kills worst performer first when multiple candidates exist', () => {
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a' },
        { subject: 'B', body: 'b' },
        { subject: 'C', body: 'c' },
      ],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 5000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
      { step: '0', variant: '1', sent: 5000, replies: 0, unique_replies: 0, opportunities: 1, unique_opportunities: 1 },
      { step: '0', variant: '2', sent: 2000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    // Variant 0: 0 opps -> Infinity ratio (worst)
    // Variant 1: ratio 5000, exceeds 5000*1.1=5500? No, 5000 <= 5500 -> KEEP
    // Variant 2: below threshold -> SKIP
    // Only variant 0 is a kill candidate
    const result = evaluateStep(analytics, step, 0, 5000);
    expect(result.kills).toHaveLength(1);
    expect(result.kills[0].variantIndex).toBe(0);
  });
});

describe('checkVariantWarnings', () => {
  it('warns when variant consumes >= 70% of threshold', () => {
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a' },
        { subject: 'B', body: 'b' },
      ],
    };
    // 3500 / 5000 = 70% - exactly at warning threshold
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 3500, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].variantIndex).toBe(0);
    expect(warnings[0].pctConsumed).toBeGreaterThanOrEqual(70);
  });
});

describe('evaluateWinner', () => {
  it('detects winner meeting all criteria', () => {
    // killThreshold = 5000
    // minSends = 5000 * 0.5 = 2500. 3000 >= 2500
    // minOpps = 5. 10 >= 5
    // ratio = 3000/10 = 300. winnerThreshold = 5000 * 0.66 = 3300. 300 <= 3300
    const result = evaluateWinner(3000, 10, 5000);
    expect(result.isWinner).toBe(true);
    expect(result.ratio).toBeDefined();
    expect(result.winnerThreshold).toBeDefined();
  });

  it('rejects winner with insufficient opportunities', () => {
    const result = evaluateWinner(3000, 3, 5000);
    expect(result.isWinner).toBe(false);
    expect(result.reason).toContain('Insufficient opportunities');
  });

  it('rejects winner with insufficient sends', () => {
    // killThreshold = 5000, minSends = 2500. 2000 < 2500
    const result = evaluateWinner(2000, 10, 5000);
    expect(result.isWinner).toBe(false);
    expect(result.reason).toContain('Insufficient sends');
  });
});
