import { buildAuditSummary } from '../src/plugins/request-audit/api-routes.js';

describe('request audit api aggregation', () => {
  test('summarizes usage models accounts and context sections', () => {
    const summary = buildAuditSummary([
      {
        request: { model: 'gpt-5.5', toProvider: 'openai-codex-oauth' },
        account: { providerNameDisplay: 'A' },
        usage: { promptTokens: 1000, cachedTokens: 100, completionTokens: 20, reasoningTokens: 5, totalTokens: 1025 },
        contextBreakdown: { sections: [{ id: 'conversation', calibratedTokens: 800 }, { id: 'tools', calibratedTokens: 200 }] }
      },
      {
        request: { model: 'gpt-5.4-mini', toProvider: 'openai-codex-oauth' },
        account: { providerNameDisplay: 'B' },
        usage: { promptTokens: 500, cachedTokens: 50, completionTokens: 10, reasoningTokens: 0, totalTokens: 510 },
        contextBreakdown: { sections: [{ id: 'conversation', calibratedTokens: 450 }] }
      }
    ]);

    expect(summary.summary).toMatchObject({
      requestCount: 2,
      promptTokens: 1500,
      cachedTokens: 150,
      completionTokens: 30,
      reasoningTokens: 5,
      totalTokens: 1535,
      cacheHitRatio: 0.1
    });
    expect(summary.models['gpt-5.5'].requestCount).toBe(1);
    expect(summary.accounts.A.promptTokens).toBe(1000);
    expect(summary.contextSections.conversation.tokens).toBe(1250);
  });
});
