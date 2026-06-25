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

    test('uses configured global proxy agents when provider proxy is enabled in config', () => {
        const axiosConfig = { timeout: 1000 };

        const result = configureAxiosProxy(axiosConfig, {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['openai-codex-oauth']
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeDefined();
        expect(result.httpsAgent).toBeDefined();
    });

    test('ignores legacy provider node PROXY_URL without global provider allowlist', () => {
        const axiosConfig = { timeout: 1000 };

        const result = configureAxiosProxy(axiosConfig, {
            uuid: 'codex-node-1',
            customName: 'Codex Node 1',
            PROXY_URL: 'socks5h://127.0.0.1:11001'
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeUndefined();
        expect(result.httpsAgent).toBeUndefined();
    });

    test('ignores legacy provider node PROXY_REQUIRED instead of failing closed', () => {
        const axiosConfig = { timeout: 1000 };

        const result = configureAxiosProxy(axiosConfig, {
            uuid: 'codex-node-1',
            customName: 'Codex Node 1',
            PROXY_REQUIRED: true,
            PROXY_URL: 'ftp://127.0.0.1:11001'
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeUndefined();
        expect(result.httpsAgent).toBeUndefined();
    });
});
