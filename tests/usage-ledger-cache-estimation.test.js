import {
  median,
  selectCacheRateBaseline,
  estimateCachedTokens,
} from '../scripts/usage-ledger/daily-usage-ledger.mjs';

describe('usage ledger cache estimation', () => {
  test('computes an odd and even median', () => {
    expect(median([0.7, 0.1, 0.3])).toBe(0.3);
    expect(median([0.1, 0.7, 0.3, 0.5])).toBe(0.4);
  });

  test('prefers model history and falls back to key history', () => {
    const history = Object.fromEntries(['06', '07', '08', '09', '10', '11', '12'].map((day, index) => [`2026-08-${day}`, {
      summary: { promptTokens: 100, cachedTokens: 20 },
      models: { sol: { promptTokens: 100, cachedTokens: index % 2 ? 60 : 40 } },
    }]));
    expect(selectCacheRateBaseline({ history, targetDate: '2026-08-13', model: 'sol' })).toMatchObject({
      rate: 0.4,
      source: 'estimated:key-model-7d-median',
    });
    expect(selectCacheRateBaseline({ history, targetDate: '2026-08-13', model: 'missing' })).toMatchObject({
      rate: 0.2,
      source: 'estimated:key-7d-median',
    });
  });

  test('does not exceed prompt and preserves observed values', () => {
    expect(estimateCachedTokens({ promptTokens: 101, observedCachedTokens: 0, baseline: { rate: 0.6, source: 'x', window: 'w', sampleDays: 7 } })).toMatchObject({
      cachedTokens: 61,
      estimatedCachedTokens: 61,
      dataQuality: 'estimated',
    });
    expect(estimateCachedTokens({ promptTokens: 100, observedCachedTokens: 80, baseline: { rate: 0.4, source: 'x', window: 'w', sampleDays: 7 } })).toMatchObject({
      cachedTokens: 80,
      dataQuality: 'observed',
    });
  });
});
