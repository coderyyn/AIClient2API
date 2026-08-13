import { createLedgerRangeAggregator } from '../src/plugins/api-potluck/ledger-range-stats.js';

test('aggregates estimated metadata and keeps mixed quality explicit', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  aggregator.addRow({
    date: '2026-08-13', model: 'gpt-5.6-sol', provider: 'codex', accountKey: 'codex:a',
    usage: { requestCount: 2, promptTokens: 100, cachedTokens: 40, completionTokens: 10, totalTokens: 110 },
    dataQuality: 'estimated', observedCachedTokens: 0, estimatedCachedTokens: 40,
    cacheRateSource: 'estimated:key-model-7d-median',
    baseline: { window: '2026-08-06..2026-08-12', sampleDays: 7, medianCacheHitRatio: 0.4 },
  });
  aggregator.addRow({
    date: '2026-08-13', model: 'gpt-5.6-sol', provider: 'codex', accountKey: 'codex:a',
    usage: { requestCount: 1, promptTokens: 50, cachedTokens: 0, completionTokens: 5, totalTokens: 55 },
  });
  const result = aggregator.result();
  expect(result.summary).toMatchObject({
    cachedTokens: 40,
    observedCachedTokens: 0,
    estimatedCachedTokens: 40,
    dataQuality: 'mixed',
    cacheRateSource: 'estimated:key-model-7d-median',
  });
});
