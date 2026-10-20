import { describe, expect, jest, test } from '@jest/globals';

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(function OAuth2Client() {
        this.on = jest.fn();
        this.setCredentials = jest.fn();
    })
}));
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ handleGeminiAntigravityOAuth: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { isAntigravityAccountDisabledError } from '../src/utils/common.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

const TOS_MESSAGE = 'This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.';

function tosError() {
    return Object.assign(new Error(TOS_MESSAGE), {
        code: 403,
        response: {
            status: 403,
            data: { error: { code: 403, status: 'PERMISSION_DENIED', message: TOS_MESSAGE, details: [{ reason: 'TOS_VIOLATION' }] } }
        }
    });
}

function createService(probeError) {
    const service = new AntigravityApiService({
        MODEL_PROVIDER: 'gemini-antigravity',
        ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
        PROJECT_ID: 'test-project'
    });
    service.authClient = { request: jest.fn().mockRejectedValue(probeError) };
    return service;
}

describe('Antigravity account disabled detection', () => {
    test('recognises the Terms of Service 403 in unary and stream shapes only', () => {
        expect(isAntigravityAccountDisabledError(tosError())).toBe(true);
        const streamError = new Error(`Upstream API Error (Status 403): ${JSON.stringify(tosError().response.data)}`);
        streamError.response = { status: 403, data: JSON.stringify(tosError().response.data) };
        expect(isAntigravityAccountDisabledError(streamError)).toBe(true);

        const plain403 = Object.assign(new Error('Permission denied on resource project'), { response: { status: 403 } });
        expect(isAntigravityAccountDisabledError(plain403)).toBe(false);
        const quota429 = Object.assign(new Error(TOS_MESSAGE), { response: { status: 429 } });
        expect(isAntigravityAccountDisabledError(quota429)).toBe(false);
    });

    test('a banned model probe makes requests fail as account disabled', async () => {
        const service = createService(tosError());
        await service._fetchAvailableModelsOnce();

        expect(() => service.buildAntigravityPayload('gemini-2.5-flash-lite', { contents: [] }))
            .toThrow(expect.objectContaining({ code: 'ANTIGRAVITY_ACCOUNT_DISABLED', status: 403, shouldSwitchCredential: true }));
    });

    test('an ordinary probe failure still reports unverifiable capabilities', async () => {
        const service = createService(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        await service._fetchAvailableModelsOnce();

        expect(() => service.buildAntigravityPayload('gemini-2.5-flash-lite', { contents: [] }))
            .toThrow(expect.objectContaining({ code: 'MODEL_LIST_UNAVAILABLE', status: 503 }));
    });
});
