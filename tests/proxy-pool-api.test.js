import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, test, jest } from '@jest/globals';
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

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

import { serviceInstances } from '../src/providers/adapter.js';
import {
    handleGetProxyPools,
    handleSaveProxyPools
} from '../src/ui-modules/proxy-pool-api.js';

let tempDir = null;

afterEach(() => {
    Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

function makeTempConfig(providerPools = {}) {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-proxy-api-${Date.now()}-`), { recursive: true });
    const proxyPoolsPath = join(tempDir, 'proxy-pools.json');
    const providerPoolsPath = join(tempDir, 'provider-pools.json');
    writeFileSync(proxyPoolsPath, '[]', 'utf8');
    writeFileSync(providerPoolsPath, JSON.stringify(providerPools, null, 2), 'utf8');
    return {
        PROXY_POOLS_FILE_PATH: proxyPoolsPath,
        PROVIDER_POOLS_FILE_PATH: providerPoolsPath
    };
}

function reqWithBody(body) {
    const req = new EventEmitter();
    req.headers = {};
    process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });
    return req;
}

function makeRes() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers;
        },
        end(payload = '') {
            this.body = payload;
        },
        json() {
            return JSON.parse(this.body || '{}');
        }
    };
}

describe('proxy pool API', () => {
    test('returns an empty list when proxy pool file does not exist', async () => {
        const currentConfig = makeTempConfig();
        rmSync(currentConfig.PROXY_POOLS_FILE_PATH, { force: true });
        const res = makeRes();

        await handleGetProxyPools({}, res, currentConfig);

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ proxies: [] });
    });

    test('saves sanitized proxy pool entries and invalidates adapters using changed proxy IDs', async () => {
        const currentConfig = makeTempConfig({
            'openai-codex-oauth': [
                { uuid: 'codex-a', PROXY_ID: 'res-ip-1' },
                { uuid: 'codex-b', PROXY_ID: 'res-ip-2' }
            ]
        });
        serviceInstances['openai-codex-oauthcodex-a'] = { stale: true };
        serviceInstances['openai-codex-oauthcodex-b'] = { keep: true };
        const res = makeRes();

        await handleSaveProxyPools(reqWithBody({
            proxies: [
                { id: 'res-ip-1', name: '<b>住宅1</b>', url: 'socks5h://127.0.0.1:11001', enabled: true, expectedIp: '154.64.234.213', note: 'bind' }
            ]
        }), res, currentConfig);

        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
        expect(JSON.parse(readFileSync(currentConfig.PROXY_POOLS_FILE_PATH, 'utf8'))).toEqual([
            { id: 'res-ip-1', name: '住宅1', url: 'socks5h://127.0.0.1:11001', enabled: true, expectedIp: '154.64.234.213', note: 'bind' }
        ]);
        expect(serviceInstances['openai-codex-oauthcodex-a']).toBeUndefined();
        expect(serviceInstances['openai-codex-oauthcodex-b']).toBeDefined();
    });
});

