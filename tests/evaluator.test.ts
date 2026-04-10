import { describe, it, expect } from 'vitest';
import { evaluateVariant, safetyCheck, evaluateStep, checkVariantWarnings, evaluateWinner } from '../src/evaluator';
import type { Step, StepAnalytics } from '../src/types';

describe('evaluateVariant', () => {
  // --- 0 opp branch ---
  it('kills variant with 0 opps at threshold', () => {
    const result = evaluateVariant(5000, 0, 5000);
    expect(result.action).toBe('KILL_CANDIDATE');
  });

  it('skips variant with 0 opps below threshold', () => {
    const result = evaluateVariant(3000, 0, 5000);
    expect(result.action).toBe('SKIP');
  });

  // --- 1 opp branch (SINGLE_OPP_RUNWAY_MULTIPLIER = 1.5) ---
  it('keeps variant with 1 opp when ratio is below 1.5x threshold', () => {
    // 5000 sent, 1 opp. Ratio = 5000. Extended = 5000 * 1.5 = 7500. 5000 < 7500 -> KEEP
    const result = evaluateVariant(5000, 1, 5000);
    expect(result.action).toBe('KEEP');
  });

  it('keeps variant with 1 opp when ratio equals 1.5x threshold exactly', () => {
    // 7500 sent, 1 opp. Ratio = 7500. Extended = 5000 * 1.5 = 7500. 7500 is NOT > 7500 -> KEEP
    const result = evaluateVariant(7500, 1, 5000);
    expect(result.action).toBe('KEEP');
  });

  it('kills variant with 1 opp when ratio exceeds 1.5x threshold', () => {
    // 7501 sent, 1 opp. Ratio = 7501. Extended = 5000 * 1.5 = 7500. 7501 > 7500 -> KILL
    const result = evaluateVariant(7501, 1, 5000);
    expect(result.action).toBe('KILL_CANDIDATE');
  });

  // --- 2+ opp branch (no multiplier, base threshold) ---
  it('keeps variant with 2 opps when ratio is below base threshold', () => {
    // 4000 sent, 2 opps. Ratio = 2000. 2000 < 5000 -> KEEP
    const result = evaluateVariant(5000, 2, 5000);
    expect(result.action).toBe('KEEP');
  });

  it('keeps variant with 2 opps when ratio equals base threshold exactly', () => {
    // 10000 sent, 2 opps. Ratio = 5000. 5000 is NOT > 5000 -> KEEP
    const result = evaluateVariant(10000, 2, 5000);
    expect(result.action).toBe('KEEP');
  });

  it('kills variant with 2 opps when ratio exceeds base threshold', () => {
    // 10002 sent, 2 opps. Ratio = 5001. 5001 > 5000 -> KILL
    const result = evaluateVariant(10002, 2, 5000);
    expect(result.action).toBe('KILL_CANDIDATE');
  });

  it('kills variant with 10 opps when ratio exceeds base threshold', () => {
    // 60000 sent, 10 opps. Ratio = 6000. 6000 > 5000 -> KILL
    const result = evaluateVariant(60000, 10, 5000);
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
      // Variant 1: 1 opp, ratio=5000. Extended threshold = 5000*1.5=7500. 5000 <= 7500 -> KEEP
      { step: '0', variant: '1', sent: 5000, replies: 0, unique_replies: 0, opportunities: 1, unique_opportunities: 1 },
      { step: '0', variant: '2', sent: 2000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    // Variant 0: 0 opps -> KILL_CANDIDATE (worst)
    // Variant 1: ratio 5000, within single-opp extended threshold 7500 -> KEEP
    // Variant 2: below threshold -> SKIP
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

  it('does not warn on a variant that will be killed (0 opps at threshold)', () => {
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a' },
        { subject: 'B', body: 'b' },
      ],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 5000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    // Variant 0 is at threshold with 0 opps - will be killed, not warned
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeUndefined();
  });

  it('warns on single-opp variant past base threshold but within 1.5x extended threshold', () => {
    // 6000 sent, 1 opp. Past threshold (5000) but within extended (7500).
    // evaluateVariant says KEEP - should get a warning.
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a' },
        { subject: 'B', body: 'b' },
      ],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 6000, replies: 0, unique_replies: 0, opportunities: 1, unique_opportunities: 1 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeDefined();
  });

  it('does not warn on single-opp variant that exceeds 1.5x extended threshold (will be killed)', () => {
    // 7501 sent, 1 opp. Ratio 7501 > extended threshold 7500 -> will be killed.
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a' },
        { subject: 'B', body: 'b' },
      ],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 7501, replies: 0, unique_replies: 0, opportunities: 1, unique_opportunities: 1 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeUndefined();
  });

  it('does not warn on 2+ opp variant that exceeds base threshold (will be killed)', () => {
    // 10002 sent, 2 opps. Ratio 5001 > base threshold 5000 -> will be killed, not warned.
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [
        { subject: 'A', body: 'a' },
        { subject: 'B', body: 'b' },
      ],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 10002, replies: 0, unique_replies: 0, opportunities: 2, unique_opportunities: 2 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeUndefined();
  });

  it('does not warn on a healthy 2+ opp variant past send threshold (ratio well under kill line)', () => {
    // 8844 sent, 3 opps -> ratio 2948. Threshold 5000. Ratio is 59% of kill line.
    // This is the Leo bug scenario.
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [{ subject: 'A', body: 'a' }, { subject: 'B', body: 'b' }],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 8844, replies: 0, unique_replies: 0, opportunities: 3, unique_opportunities: 3 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeUndefined();
  });

  it('warns on a 2+ opp variant approaching the ratio kill line', () => {
    // 7000 sent, 2 opps -> ratio 3500 = 70% of 5000 threshold. Should warn.
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [{ subject: 'A', body: 'a' }, { subject: 'B', body: 'b' }],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 7000, replies: 0, unique_replies: 0, opportunities: 2, unique_opportunities: 2 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeDefined();
  });

  it('does not warn on a highly productive variant with many opps and high sends', () => {
    // Step 2 Leo bug: 9224 sent, 8 opps -> ratio 1153. Threshold 5000. 23% of kill line.
    const step: Step = {
      type: 'email', delay: 1, delay_unit: 'day',
      variants: [{ subject: 'A', body: 'a' }, { subject: 'B', body: 'b' }],
    };
    const analytics: StepAnalytics[] = [
      { step: '0', variant: '0', sent: 9224, replies: 0, unique_replies: 0, opportunities: 8, unique_opportunities: 8 },
      { step: '0', variant: '1', sent: 1000, replies: 0, unique_replies: 0, opportunities: 0, unique_opportunities: 0 },
    ];
    const warnings = checkVariantWarnings(step, analytics, 0, 5000, []);
    expect(warnings.find((w) => w.variantIndex === 0)).toBeUndefined();
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
