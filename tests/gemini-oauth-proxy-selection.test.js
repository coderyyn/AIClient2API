import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../src/services/ui-manager.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn(),
    replaceProviderCredentialPath: jest.fn()
}));
jest.mock('../src/core/config-manager.js', () => ({ CONFIG: {} }));
jest.mock('../src/utils/tls-sidecar.js', () => ({
    getTLSSidecar: jest.fn(() => ({ isReady: jest.fn(() => false) }))
}));

import {
    assertGeminiOAuthProxyAvailable,
    createGeminiOAuthTransporterOptions,
    createGeminiPkce
} from '../src/auth/gemini-oauth.js';

let tempDir;

afterEach(() => {
    jest.clearAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
});

function writeProxyPools(pools) {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-gemini-oauth-${Date.now()}-`), { recursive: true });
    const filePath = join(tempDir, 'proxy-pools.json');
    writeFileSync(filePath, JSON.stringify(pools, null, 2), 'utf8');
    return filePath;
}

describe('Gemini OAuth account proxy selection', () => {
    test('accepts direct access and an enabled selected proxy', () => {
        const filePath = writeProxyPools([
            { id: 'proxy-enabled', url: 'http://127.0.0.1:7890', enabled: true }
        ]);

        expect(assertGeminiOAuthProxyAvailable({ PROXY_POOLS_FILE_PATH: filePath }, '')).toBeNull();
        expect(assertGeminiOAuthProxyAvailable({ PROXY_POOLS_FILE_PATH: filePath }, 'proxy-enabled'))
            .toMatchObject({ id: 'proxy-enabled', enabled: true });
    });

    test.each([
        ['missing', []],
        ['disabled', [{ id: 'proxy-disabled', url: 'http://127.0.0.1:7890', enabled: false }]],
        ['unsupported', [{ id: 'proxy-unsupported', url: 'ftp://127.0.0.1:21', enabled: true }]]
    ])('rejects %s selected proxies before OAuth starts', (_label, pools) => {
        const filePath = writeProxyPools(pools);
        const proxyId = pools[0]?.id || 'proxy-missing';

        expect(() => assertGeminiOAuthProxyAvailable({ PROXY_POOLS_FILE_PATH: filePath }, proxyId))
            .toThrow(`Selected proxy node is unavailable: ${proxyId}`);
    });

    test('selected proxy and explicit direct access both disable ambient proxy fallback', () => {
        const proxied = createGeminiOAuthTransporterOptions({}, 'gemini-antigravity', {
            selectedProxyUrl: 'http://127.0.0.1:7890'
        });
        const direct = createGeminiOAuthTransporterOptions({
            PROXY_URL: 'http://127.0.0.1:7891',
            PROXY_ENABLED_PROVIDERS: ['gemini-antigravity']
        }, 'gemini-antigravity', { forceDirect: true });

        expect(proxied.proxy).toBe(false);
        expect(proxied.agent).toBeDefined();
        expect(direct).toEqual({ proxy: false });
    });

    test('creates S256 PKCE material for each authorization session', () => {
        const first = createGeminiPkce();
        const second = createGeminiPkce();

        expect(first.verifier.length).toBeGreaterThanOrEqual(43);
        expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(first.challenge).not.toBe(first.verifier);
        expect(second.verifier).not.toBe(first.verifier);
    });
});
