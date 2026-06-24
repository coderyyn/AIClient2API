import plugin from '../src/plugins/request-audit/index.js';

describe('request audit plugin', () => {
  test('exposes Chinese plugin description in plugin manager', () => {
    expect(plugin.description).toContain('请求审计');
    expect(plugin.description).toContain('不保存原始 prompt');
    expect(plugin.description).toContain('request-audit.html');
  });

  test('writes finalized event with merged usage', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-1',
      nativeResponse: {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          total_tokens: 1020,
          prompt_tokens_details: { cached_tokens: 100 }
        }
      },
      model: 'gpt-5.5'
    });

    await plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-1',
      potluckApiKey: 'maki_secret_key',
      originalRequestBody: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] },
      model: 'gpt-5.5',
      toProvider: 'openai-codex-oauth'
    });

    expect(auditStore.append).toHaveBeenCalledTimes(1);
    expect(auditStore.append.mock.calls[0][0].usage).toMatchObject({
      promptTokens: 1000,
      cachedTokens: 100,
      completionTokens: 20,
      totalTokens: 1020
    });
  });
});
