import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/utils/tls-sidecar.js', () => ({ getTLSSidecar: jest.fn(() => ({ isReady: () => false })) }));
import axios from 'axios';
import { detectProxyGeo, refreshProxyGeo } from '../src/utils/proxy-geo.js';
import { proxyGeoIsVerified, proxyRouteHash, assertCodexProxyBinding, CODEX_PROXY_SNAPSHOT } from '../src/utils/proxy-pool-store.js';
import { configureTLSSidecar, parseProxyUrl } from '../src/utils/proxy-utils.js';
import { getTLSSidecar } from '../src/utils/tls-sidecar.js';

let dir;
afterEach(() => { jest.clearAllMocks(); if (dir) rmSync(dir, { recursive: true }); dir = null; });
const entry = { id: 'test-proxy', url: 'http://127.0.0.1:7890', enabled: true, expectedIp: '' };
const data = { ip: '203.0.113.10', country_code: 'US', country: 'United States', timezone: 'America/Los_Angeles' };
describe('proxy geo trust and route selection', () => {
    test('accepts country and valid timezone without city through the selected proxy', async () => {
        axios.get.mockResolvedValue({ data });
        const geo = await detectProxyGeo(entry);
        expect(proxyGeoIsVerified({ ...entry, geo })).toBe(true);
        expect(geo.city).toBe('');
        expect(axios.get.mock.calls[0][1]).toMatchObject({ proxy: false, timeout: 15000, maxRedirects: 0 });
    });
    test.each([{ ...data, country_code: '' }, { ...data, timezone: 'invalid/zone' }])('rejects incomplete geo: %p', async invalid => {
        axios.get.mockResolvedValue({ data: invalid });
        expect((await detectProxyGeo(entry)).status).toBe('error');
    });
    test('retains observed exit on expected-IP mismatch and last success on network failure', async () => {
        axios.get.mockResolvedValue({ data });
        const old = await detectProxyGeo(entry);
        expect(await detectProxyGeo({ ...entry, expectedIp: '203.0.113.99' })).toMatchObject({ status: 'error', ip: data.ip });
        axios.get.mockRejectedValue(new Error('proxy URL with credentials must not be exposed'));
        const failed = await detectProxyGeo({ ...entry, geo: old });
        expect(failed).toMatchObject({ status: 'error', errorCode: 'PROXY_GEO_LOOKUP_FAILED', lastSuccess: old });
        expect(JSON.stringify(failed)).not.toContain('credentials');
    });
    test('rejects stale network results when address changes during detection', async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'proxy-geo-'));
        const file = path.join(dir, 'pools.json');
        writeFileSync(file, JSON.stringify([entry]));
        let finish;
        axios.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const work = refreshProxyGeo({ PROXY_POOLS_FILE_PATH: file }, entry);
        writeFileSync(file, JSON.stringify([{ ...entry, url: 'http://127.0.0.1:7891' }]));
        finish({ data });
        expect(await work).toBeNull();
        expect(JSON.parse(readFileSync(file))[0]).not.toHaveProperty('geo');
    });
    test('binding fails without valid cached data but unchanged bindings can be edited', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'proxy-bind-'));
        const file = path.join(dir, 'pools.json');
        writeFileSync(file, JSON.stringify([entry]));
        const config = { PROXY_POOLS_FILE_PATH: file };
        expect(() => assertCodexProxyBinding(config, 'openai-codex-oauth', { PROXY_ID: entry.id })).toThrow();
        expect(() => assertCodexProxyBinding(config, 'openai-codex-oauth', { PROXY_ID: entry.id }, { PROXY_ID: entry.id })).not.toThrow();
    });
    test('HTTP and sidecar use the same verified snapshot despite competing proxy settings', () => {
        const snapshot = { ...entry, geo: { status: 'verified', ...data, countryCode: 'US', routeHash: proxyRouteHash(entry) } };
        const config = { uuid: 'test', PROXY_ID: entry.id, [CODEX_PROXY_SNAPSHOT]: snapshot, ipNodeProxy: { getProxyUrl: () => 'http://127.0.0.1:7899' }, TLS_SIDECAR_PROXY_URL: 'http://127.0.0.1:7898' };
        const plain = configureTLSSidecar({}, config, 'openai-codex-oauth');
        expect(plain.httpsAgent).toBe(parseProxyUrl(entry.url).httpsAgent);
        const wrap = jest.fn();
        getTLSSidecar.mockReturnValueOnce({ isReady: () => true, wrapAxiosConfig: wrap });
        configureTLSSidecar({}, { ...config, TLS_SIDECAR_ENABLED: true, TLS_SIDECAR_ENABLED_PROVIDERS: ['openai-codex-oauth'] }, 'openai-codex-oauth');
        expect(wrap).toHaveBeenCalledWith(expect.any(Object), entry.url);
    });
});
