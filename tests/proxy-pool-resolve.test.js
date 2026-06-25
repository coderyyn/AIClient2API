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
            { id: 'res-ip-1', name: '住宅号池1', url: 'socks5h://127.0.0.1:11001', enabled: true }
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

    test('ignores disabled selected proxy pool entry without legacy fail-closed mode', () => {
        const proxyPoolsPath = writeProxyPools([
            { id: 'res-ip-1', name: '住宅号池1', url: 'socks5h://127.0.0.1:11001', enabled: false }
        ]);

        const result = configureAxiosProxy({ timeout: 1000 }, {
            uuid: 'codex-node-1',
            PROXY_ID: 'res-ip-1',
            PROXY_REQUIRED: true,
            PROXY_POOLS_FILE_PATH: proxyPoolsPath
        }, 'openai-codex-oauth');

        expect(result.proxy).toBe(false);
        expect(result.httpAgent).toBeUndefined();
        expect(result.httpsAgent).toBeUndefined();
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
