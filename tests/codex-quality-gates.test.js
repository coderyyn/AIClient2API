import { afterEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { CODEX_FINGERPRINT_CONTEXT_KEY } from '../src/providers/openai/codex-fingerprint.js';
import { extractInboundCodexFingerprintContext } from '../src/utils/common.js';
import {
    CodexPromptCacheObservability,
    codexPromptCacheObservability
} from '../src/providers/openai/codex-prompt-cache-observability.js';
import { postCodexOAuthRefreshRequest } from '../src/auth/codex-oauth.js';

jest.mock('axios', () => ({
    request: jest.fn(),
    create: jest.fn()
}));

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/core/config-manager.js', () => ({
    CONFIG: {}
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    autoLinkProviderConfigs: jest.fn(),
    replaceProviderCredentialPath: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null),
    configureAxiosProxy: jest.fn(config => config),
    parseProxyUrl: jest.fn(() => null)
}));

function createService(overrides = {}) {
    const service = new CodexApiService({
        MODEL_PROVIDER: 'openai-codex-oauth',
        uuid: 'provider-secret-uuid',
        codexAccountKey: 'stable-account-key',
        CODEX_FINGERPRINT_ENABLED: false,
        ...overrides
    });
    service.isInitialized = true;
    service.accessToken = 'access-token-secret';
    service.accountId = 'account-id';
    service.expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    return service;
}

function getHeader(headers, expectedName) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    return entry?.[1];
}

afterEach(() => {
    jest.restoreAllMocks();
    axios.request.mockReset();
});

describe('Codex proxy quality gates', () => {
    test.each([
        ['session-id', 'dash-session'],
        ['session_id', 'underscore-session'],
        ['Session_id', 'legacy-session'],
        ['Session-Id', 'canonical-session']
    ])('accepts inbound %s but emits only canonical Session-Id', (inputName, inputValue) => {
        const service = createService();

        try {
            const headers = service.buildHeaders('cache-session', false, {
                inboundHeaders: { [inputName]: inputValue },
                ids: null
            });
            const sessionHeaders = Object.entries(headers)
                .filter(([name]) => ['session-id', 'session_id'].includes(name.toLowerCase()));

            expect(sessionHeaders).toEqual([['Session-Id', inputValue]]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not forward the internal Responses Lite marker to upstream', () => {
        const service = createService();

        try {
            const present = service.buildHeaders(null, false, {
                inboundHeaders: { 'x-openai-internal-codex-responses-lite': 'true' },
                ids: null
            });

            expect(getHeader(present, 'X-Openai-Internal-Codex-Responses-Lite')).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('captures the allowlisted Codex routing headers before provider selection', () => {
        const context = extractInboundCodexFingerprintContext({
            headers: {
                'x-codex-window-id': 'window-private',
                'thread-id': 'thread-private',
                'x-openai-internal-codex-responses-lite': 'true',
                'x-unrelated-private-header': 'must-not-pass'
            }
        }, {});

        expect(context.inboundCodexHeaders).toEqual({
            'x-codex-window-id': 'window-private',
            'thread-id': 'thread-private',
            'x-openai-internal-codex-responses-lite': 'true'
        });
        expect(context.inboundCodexHeaders['x-unrelated-private-header']).toBeUndefined();
    });

    test('preserves prompt_cache_options byte-for-byte through Codex body preparation', async () => {
        const service = createService();
        const promptCacheOptions = { retention: '24h', nested: { mode: 'private-value' } };

        try {
            const prepared = await service.prepareRequestBody('gpt-5.4-mini', {
                input: [{ role: 'user', content: 'secret prompt' }],
                prompt_cache_options: promptCacheOptions
            }, true);

            expect(prepared.prompt_cache_options).toBe(promptCacheOptions);
            expect(prepared.prompt_cache_options).toEqual(promptCacheOptions);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('records only sanitized prompt_cache_options presence and upstream 400 statistics', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        const metrics = new CodexPromptCacheObservability({ logger });
        const options = {
            retention: 'private-retention-value',
            nested: { prompt: 'private-prompt', email: 'user@example.com', token: 'token-secret' }
        };

        metrics.recordPresence({
            providerType: 'openai-codex-oauth',
            providerUuid: 'provider-secret-uuid',
            promptCacheOptions: options
        });
        metrics.recordUpstreamError({
            providerType: 'openai-codex-oauth',
            providerUuid: 'provider-secret-uuid',
            promptCacheOptions: options,
            httpStatus: 400,
            errorClass: 'invalid_request_error'
        });

        const snapshot = metrics.snapshot();
        const output = JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.warn.mock.calls) + JSON.stringify(snapshot);
        expect(snapshot).toMatchObject({
            present: 1,
            upstream400: 1,
            byProviderType: { 'openai-codex-oauth': { present: 1, upstream400: 1 } }
        });
        expect(output).toContain('shapeHash');
        expect(output).not.toContain('private-retention-value');
        expect(output).not.toContain('private-prompt');
        expect(output).not.toContain('user@example.com');
        expect(output).not.toContain('token-secret');
        expect(output).not.toContain('provider-secret-uuid');
    });

    test('does not observe prompt_cache_options for non-Codex OAuth providers', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        const metrics = new CodexPromptCacheObservability({ logger });

        expect(metrics.recordPresence({
            providerType: 'openai-api-key',
            promptCacheOptions: { retention: 'private-value' }
        })).toBeNull();
        expect(metrics.snapshot()).toEqual({ present: 0, upstream400: 0, byProviderType: {} });
        expect(logger.info).not.toHaveBeenCalled();
    });

    test('associates an upstream 400 with prompt_cache_options without modifying the request', async () => {
        axios.request.mockRejectedValueOnce({
            response: { status: 400, data: { error: { type: 'invalid_request_error', message: 'bad request' } } },
            message: 'bad request'
        });
        const presenceSpy = jest.spyOn(codexPromptCacheObservability, 'recordPresence');
        const errorSpy = jest.spyOn(codexPromptCacheObservability, 'recordUpstreamError');
        const service = createService();
        const options = { retention: 'private-retention-value' };
        const request = {
            model: 'gpt-5.4-mini',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'secret prompt' }] }],
            prompt_cache_options: options,
            [CODEX_FINGERPRINT_CONTEXT_KEY]: { inboundCodexHeaders: {}, originalClientSessionId: '' }
        };

        try {
            await expect(service.generateContent('gpt-5.4-mini', request)).rejects.toBeTruthy();
            expect(axios.request.mock.calls[0][0].data.prompt_cache_options).toBe(options);
            expect(presenceSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
                providerType: 'openai-codex-oauth',
                httpStatus: 400,
                promptCacheOptions: options
            }));
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('OAuth token requests abort the underlying call after 30 seconds', async () => {
        jest.useFakeTimers();
        try {
            let capturedConfig;
            const httpClient = {
                post: jest.fn((_url, _data, config) => {
                    capturedConfig = config;
                    return new Promise((_resolve, reject) => {
                        config.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
                            code: 'ERR_CANCELED'
                        })), { once: true });
                    });
                })
            };
            const request = postCodexOAuthRefreshRequest(httpClient, 'https://auth.openai.com/oauth/token', 'body', {
                Accept: 'application/json'
            });

            expect(capturedConfig.timeout).toBe(30000);
            expect(capturedConfig.signal.aborted).toBe(false);
            jest.advanceTimersByTime(30000);
            await expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
            expect(capturedConfig.signal.aborted).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});
