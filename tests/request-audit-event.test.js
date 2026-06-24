import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';

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
    expect(serialized).not.toContain('user@example.com');
    expect(event.contextBreakdown.estimationMethod).toBe('usage-only-fast');
    expect(event.contextBreakdown.sections.map(section => section.id)).toEqual(expect.arrayContaining(['conversation', 'cached_input']));
    expect(event.fingerprint.payloadHash).toMatch(/^sha256:/);
    expect(event.fingerprint.sections.conversation.charLength).toBeGreaterThan(0);
  });

  test('uses deep context breakdown only when explicitly requested', () => {
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

    expect(event.contextBreakdown.estimationMethod).toContain('calibrated');
    expect(event.contextBreakdown.sections.map(section => section.id)).toEqual(expect.arrayContaining(['instructions', 'tools', 'conversation']));
  });
});
