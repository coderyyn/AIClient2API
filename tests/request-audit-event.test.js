import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';
import { buildAuditSummary } from '../src/plugins/request-audit/api-routes.js';

describe('request audit event', () => {
  test('builds sanitized audit event with key hash and no raw prompt', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-1',
      potluckApiKey: 'maki_4734b4e5fe29dc2af36d8296a46f3462',
      providerName: 'user@example.com',
      fromProvider: 'openai',
      toProvider: 'openai-codex-oauth',
      providerUuid: 'uuid-1',
      model: 'gpt-5.5',
      originalRequestBody: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'secret prompt text' }]
      },
      usage: { promptTokens: 1000, cachedTokens: 100, totalTokens: 1100 }
    });

    const serialized = JSON.stringify(event);
    expect(event.potluckKey.hash).toMatch(/^sha256:/);
    expect(event.potluckKey.prefix).toBe('maki_4734b4...');
    expect(event.account.providerNameDisplay).toMatch(/^redacted-email:/);
    expect(serialized).not.toContain('maki_4734b4e5fe29dc2af36d8296a46f3462');
    expect(serialized).not.toContain('secret prompt text');
    expect(event.account.accountEmail).toBe('user@example.com');
    expect(event).not.toHaveProperty('fingerprint');
    expect(event).not.toHaveProperty('contextBreakdown');
  });

  test('omits diagnostic payload fields even when deep context breakdown is requested', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-deep',
      model: 'gpt-5.5',
      deepContextBreakdown: true,
      originalRequestBody: {
        model: 'gpt-5.5',
        instructions: 'system text',
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        input: [{ role: 'user', content: 'hello' }]
      },
      usage: { promptTokens: 1000, cachedTokens: 100, totalTokens: 1100 }
    });

    expect(event).not.toHaveProperty('fingerprint');
    expect(event).not.toHaveProperty('contextBreakdown');
  });

  test('keeps requested and actual model when server-side model fallback is used', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-model-fallback',
      model: 'gpt-5.4-mini',
      originalRequestBody: {
        model: 'gpt-5.3-codex-spark',
        messages: [{ role: 'user', content: 'hello' }]
      },
      processedRequestBody: {
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }]
      },
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });

    expect(event.request).toMatchObject({
      model: 'gpt-5.4-mini',
      requestedModel: 'gpt-5.3-codex-spark',
      actualModel: 'gpt-5.4-mini'
    });
  });

  test('records real account email when routing context provides it', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-account-email',
      providerName: 'codex-account-a',
      providerUuid: 'uuid-1',
      accountEmail: 'Codex.User@Example.COM',
      model: 'gpt-5.5',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });

    expect(event.account).toMatchObject({
      providerUuid: 'uuid-1',
      accountEmail: 'codex.user@example.com'
    });
  });

  test('uses account email as the summary account key when present', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-summary-account-email',
      providerName: 'codex-account-a',
      providerUuid: 'uuid-1',
      accountEmail: 'codex.user@example.com',
      model: 'gpt-5.5',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });

    const summary = buildAuditSummary([event]);

    expect(summary.accounts['codex.user@example.com']).toMatchObject({
      requestCount: 1,
      totalTokens: 12
    });
    expect(summary.accounts['codex-account-a']).toBeUndefined();
  });

  test('does not add reasoning tokens to completion tokens when normalizing usage', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-reasoning-usage',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 1000,
        output_tokens: 120,
        output_tokens_details: {
          reasoning_tokens: 80
        },
        total_tokens: 1120
      }
    });

    expect(event.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 120,
      reasoningTokens: 80,
      totalTokens: 1120
    });
  });
});
