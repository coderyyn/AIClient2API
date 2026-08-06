import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        runWithContext: jest.fn((_requestId, callback) => callback())
    }
}));

jest.mock('../src/utils/context.js', () => ({
    __esModule: true,
    default: { run: jest.fn((_context, callback) => callback()) }
}));

jest.mock('../src/utils/common.js', () => ({
    handleError: jest.fn(),
    getClientIp: jest.fn(() => '127.0.0.1'),
    getRequestBody: jest.fn(),
    countTokensAnthropic: jest.fn()
}));

jest.mock('../src/services/ui-manager.js', () => ({
    handleUIApiRequests: jest.fn(async () => false),
    serveStaticFiles: jest.fn(async () => false)
}));

jest.mock('../src/utils/ui-utils.js', () => ({
    isUIPath: jest.fn(() => false),
    isUIApiPath: jest.fn(() => false)
}));

jest.mock('../src/services/api-manager.js', () => ({
    handleAPIRequests: jest.fn(async () => true)
}));

jest.mock('../src/services/service-manager.js', () => ({
    getApiService: jest.fn(),
    getProviderStatus: jest.fn(),
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
    isRegisteredProvider: jest.fn(provider => provider === 'gemini-antigravity')
}));

jest.mock('../src/core/config-manager.js', () => ({
    PROMPT_LOG_FILENAME: null
}));

const mockPluginManager = {
    isPluginStaticPath: jest.fn(() => false),
    getPluginByStaticPath: jest.fn(() => null),
    executeRoutes: jest.fn(async () => false),
    executeAuth: jest.fn(async () => ({ handled: false, authorized: true })),
    executeMiddleware: jest.fn(async () => ({ handled: false }))
};

jest.mock('../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => mockPluginManager)
}));

jest.mock('../src/utils/grok-assets-proxy.js', () => ({
    handleGrokAssetsProxy: jest.fn()
}));

import defaultAuthPlugin from '../src/plugins/default-auth/index.js';
import { createRequestHandler } from '../src/handlers/request-handler.js';
import { handleError } from '../src/utils/common.js';
import { handleUIApiRequests } from '../src/services/ui-manager.js';
import { handleAPIRequests as mockHandleAPIRequests } from '../src/services/api-manager.js';

function makeResponse() {
    return {
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        writeHead: jest.fn(),
        end: jest.fn()
    };
}

describe('Gemini native route and authentication contract', () => {
    test.each([
        ['query key', {}, 'http://localhost/v1beta/models/gemini-3.1-flash-image:generateContent?key=contract-key'],
        ['x-goog-api-key', { 'x-goog-api-key': 'contract-key' }, 'http://localhost/v1beta/models/gemini-3.1-flash-image:generateContent'],
        ['Bearer token', { authorization: 'Bearer contract-key' }, 'http://localhost/v1beta/models/gemini-3.1-flash-image:generateContent']
    ])('accepts %s authentication', async (_label, headers, url) => {
        const result = await defaultAuthPlugin.authenticate(
            { headers },
            {},
            new URL(url),
            { REQUIRED_API_KEY: 'contract-key' }
        );

        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('strips the gemini-antigravity provider prefix before routing generateContent', async () => {
        const handler = createRequestHandler({
            UI_ENABLED: false,
            MODEL_PROVIDER: 'gemini-cli-oauth',
            REQUIRED_API_KEY: 'contract-key'
        }, null);
        const req = {
            method: 'POST',
            url: '/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent?key=contract-key',
            headers: { host: 'localhost:3000' },
            socket: { encrypted: false }
        };

        await handler(req, makeResponse());

        expect(handleError).not.toHaveBeenCalled();
        expect(handleUIApiRequests).toHaveBeenCalledTimes(1);
        expect(mockHandleAPIRequests).toHaveBeenCalledTimes(1);
        const [method, path, , , currentConfig] = mockHandleAPIRequests.mock.calls[0];
        expect(method).toBe('POST');
        expect(path).toBe('/v1beta/models/gemini-3.1-flash-image:generateContent');
        expect(currentConfig.MODEL_PROVIDER).toBe('gemini-antigravity');
    });
});
