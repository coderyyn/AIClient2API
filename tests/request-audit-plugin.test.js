import plugin from '../src/plugins/request-audit/index.js';

async function waitFor(expectation, timeoutMs = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      expectation();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

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

    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    expect(auditStore.append.mock.calls[0][0].usage).toMatchObject({
      promptTokens: 1000,
      cachedTokens: 100,
      completionTokens: 20,
      totalTokens: 1020
    });
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('fingerprint');
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('contextBreakdown');
    expect(JSON.stringify(auditStore.append.mock.calls[0][0])).not.toContain('hello');
  });

  test('does not block content generation when audit persistence is slow', async () => {
    let resolveAppend;
    const appendPromise = new Promise(resolve => {
      resolveAppend = resolve;
    });
    const auditStore = {
      append: jest.fn(() => appendPromise),
      cleanup: jest.fn()
    };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-slow',
      nativeResponse: {
        usage: {
          prompt_tokens: 500,
          completion_tokens: 20,
          total_tokens: 520
        }
      }
    });

    const result = await Promise.race([
      plugin.hooks.onContentGenerated({
        _monitorRequestId: 'req-slow',
        potluckApiKey: 'maki_secret_key',
        originalRequestBody: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] },
        model: 'gpt-5.5',
        toProvider: 'openai-codex-oauth'
      }).then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100))
    ]);

    expect(result).toBe('returned');
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    expect(auditStore.cleanup).not.toHaveBeenCalled();
    resolveAppend();
  });

  test('does not block content generation when audit input is large', async () => {
    const auditStore = {
      append: jest.fn(),
      cleanup: jest.fn()
    };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-large',
      nativeResponse: {
        usage: {
          prompt_tokens: 120000,
          completion_tokens: 20,
          total_tokens: 120020
        }
      }
    });

    const result = await Promise.race([
      plugin.hooks.onContentGenerated({
        _monitorRequestId: 'req-large',
        potluckApiKey: 'maki_secret_key',
        originalRequestBody: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: `secret-large-${'x'.repeat(500000)}` }],
          tools: [{ type: 'function', function: { name: 'large_tool', parameters: { description: 'y'.repeat(500000) } } }]
        },
        model: 'gpt-5.5',
        toProvider: 'openai-codex-oauth'
      }).then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100))
    ]);

    expect(result).toBe('returned');
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1), 1500);
    const eventJson = JSON.stringify(auditStore.append.mock.calls[0][0]);
    expect(eventJson).not.toContain('secret-large');
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('fingerprint');
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('contextBreakdown');
  });

  test('captures raw request only when scoped raw capture is enabled for key hash', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    const rawCaptureStore = { capture: jest.fn(), cleanup: jest.fn() };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:1f223db5f9b186a5'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-raw',
      nativeResponse: { usage: { prompt_tokens: 1000, total_tokens: 1000 } }
    });
    await plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-raw',
      potluckApiKey: 'maki_secret_key',
      originalRequestBody: { input: 'raw capture scope test' },
      model: 'gpt-5.5'
    });

    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));
    expect(rawCaptureStore.capture.mock.calls[0][0].originalRequestBody.input).toBe('raw capture scope test');
  });

  test('init cleans expired raw capture files without forcing audit cleanup', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn(async () => {}) };
    const rawCaptureStore = { capture: jest.fn(), cleanup: jest.fn(async () => {}) };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    await waitFor(() => expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(1));
    expect(auditStore.cleanup).not.toHaveBeenCalled();
    expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(1);
  });
});
