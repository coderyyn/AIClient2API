import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/utils/tls-sidecar.js', () => ({
    getTLSSidecar: jest.fn(() => ({
        isReady: jest.fn(() => false),
        wrapAxiosConfig: jest.fn()
    }))
}));

import { configureAxiosProxy } from '../src/utils/proxy-utils.js';

describe('config managed proxy control', () => {
    test('disables axios environment proxy when provider proxy is not enabled in config', () => {
        const axiosConfig = { timeout: 1000 };

        const result = configureAxiosProxy(axiosConfig, {
            PROXY_URL: null,
            PROXY_ENABLED_PROVIDERS: []
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeUndefined();
        expect(result.httpsAgent).toBeUndefined();
    });

    test('uses configured proxy agents when provider proxy is enabled in config', () => {
        const axiosConfig = { timeout: 1000 };

        const result = configureAxiosProxy(axiosConfig, {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['openai-codex-oauth']
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeDefined();
        expect(result.httpsAgent).toBeDefined();
    });
});
