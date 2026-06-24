import { buildAuditSummary, handleRequestAuditRoutes } from '../src/plugins/request-audit/api-routes.js';

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

  test('summary includes analysis freshness and diagnostic counts', async () => {
    const payload = await callRoute('/api/request-audit/summary', {
      _requestAuditStore: {
        query: jest.fn(async () => [{ requestId: 'req-1', usage: { promptTokens: 1000, cachedTokens: 10 } }])
      },
      _requestAuditAnalysisStore: {
        readFreshness: jest.fn(async () => ({ status: 'fresh', generatedAt: '2026-06-24T06:10:00.000Z', staleSeconds: 60 })),
        readDiagnostics: jest.fn(async () => ({
          'req-1': { requestId: 'req-1', primaryReason: 'prefix_changed' }
        }))
      }
    });

    expect(payload.success).toBe(true);
    expect(payload.data.analysisFreshness.status).toBe('fresh');
    expect(payload.data.diagnosticsSummary.prefix_changed).toBe(1);
  });

  test('requests attach materialized diagnosis when available', async () => {
    const payload = await callRoute('/api/request-audit/requests', {
      _requestAuditStore: {
        query: jest.fn(async () => [{ requestId: 'req-1', usage: { promptTokens: 1000, cachedTokens: 10 } }])
      },
      _requestAuditAnalysisStore: {
        readFreshness: jest.fn(async () => ({ status: 'fresh', generatedAt: '2026-06-24T06:10:00.000Z', staleSeconds: 60 })),
        readDiagnostics: jest.fn(async () => ({
          'req-1': { requestId: 'req-1', primaryReason: 'tools_changed' }
        }))
      }
    });

    expect(payload.data.requests[0].diagnosis.primaryReason).toBe('tools_changed');
  });
});

async function callRoute(path, config) {
  let statusCode = null;
  let body = '';
  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end(value) {
      body = value;
    }
  };

  await handleRequestAuditRoutes('GET', path, { url: path }, res, config);
  expect(statusCode).toBe(200);
  return JSON.parse(body);
}
