import { proxyRouteHash } from '../src/utils/proxy-pool-store.js';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, test, afterEach, jest } from '@jest/globals';
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

let tempDir = null;

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

function writeProxyPools(pools) {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-proxy-pools-${Date.now()}-`), { recursive: true });
    const filePath = join(tempDir, 'proxy-pools.json');
    writeFileSync(filePath, JSON.stringify(pools, null, 2), 'utf8');
    return filePath;
}

describe('provider proxy pool resolution', () => {
    test('uses enabled proxy pool entry selected by provider PROXY_ID', () => {
        const proxyPoolsPath = writeProxyPools([
            { id: 'res-ip-1', name: '住宅号池1', url: 'socks5h://127.0.0.1:11001', enabled: true, geo: { status: 'verified', ip: '203.0.113.1', countryCode: 'US', timezone: 'America/Los_Angeles', routeHash: proxyRouteHash({url:'socks5h://127.0.0.1:11001'}) } }
        ]);

        const result = configureAxiosProxy({ timeout: 1000 }, {
            uuid: 'codex-node-1',
            customName: 'Codex Node 1',
            PROXY_ID: 'res-ip-1',
            PROXY_POOLS_FILE_PATH: proxyPoolsPath
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeDefined();
        expect(result.httpsAgent).toBeDefined();
    });

    test('rejects disabled selected Codex proxies instead of falling back', () => {
        const proxyPoolsPath = writeProxyPools([
            { id: 'res-ip-1', name: '住宅号池1', url: 'socks5h://127.0.0.1:11001', enabled: false }
        ]);

        expect(() => configureAxiosProxy({ timeout: 1000 }, {
            uuid: 'codex-node-1', PROXY_ID: 'res-ip-1',
            PROXY_POOLS_FILE_PATH: proxyPoolsPath
        }, 'openai-codex-oauth')).toThrow('代理尚未取得有效国家和时区');
    });

    test('does not fall back to legacy provider PROXY_URL when PROXY_ID is not configured', () => {
        const result = configureAxiosProxy({ timeout: 1000 }, {
            uuid: 'codex-node-1',
            PROXY_URL: 'http://127.0.0.1:7890'
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeUndefined();
        expect(result.httpsAgent).toBeUndefined();
    });
});
