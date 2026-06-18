import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';

jest.mock('axios', () => ({
    request: jest.fn()
}));

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
    axios.request.mockReset();
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('Codex rate limit reset credits', () => {
    test('consumes a reset credit with the official Codex endpoint and redeem request id', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });
        service.isInitialized = true;
        service.accessToken = 'access-token';
        service.accountId = 'account-id';

        axios.request.mockResolvedValueOnce({
            data: { code: 'reset', windows_reset: 2 }
        });

        try {
            await expect(service.consumeRateLimitResetCredit('redeem-123')).resolves.toEqual({
                code: 'reset',
                windows_reset: 2
            });

            expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
                method: 'post',
                url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
                data: { redeem_request_id: 'redeem-123' },
                timeout: 30000,
                headers: expect.objectContaining({
                    authorization: 'Bearer access-token',
                    'chatgpt-account-id': 'account-id',
                    'content-type': 'application/json'
                })
            }));
        } finally {
            service.stopCacheCleanup();
        }
    });
});
