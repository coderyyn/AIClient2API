import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let consoleSpies = [];

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('Codex session cache key handling', () => {
    test('uses a Codex client version new enough for GPT-5.6 models', () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const headers = service.buildHeaders(null, false);

            expect(headers.version).toBe('0.144.1');
            expect(headers['user-agent']).toContain('codex-tui/0.144.1');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('uses Codex CLI client metadata session id when metadata is absent', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const first = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'first' }],
                client_metadata: {
                    session_id: 'codex-cli-session-a'
                }
            }, true);

            const second = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'second' }],
                client_metadata: {
                    session_id: 'codex-cli-session-b'
                }
            }, true);

            expect(first.prompt_cache_key).toBeTruthy();
            expect(second.prompt_cache_key).toBeTruthy();
            expect(first.prompt_cache_key).not.toBe(second.prompt_cache_key);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('preserves explicit prompt_cache_key from the client request', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'reuse cache' }],
                prompt_cache_key: 'client-provided-cache-key'
            }, true);

            expect(body.prompt_cache_key).toBe('client-provided-cache-key');
        } finally {
            service.stopCacheCleanup();
        }
    });
});
