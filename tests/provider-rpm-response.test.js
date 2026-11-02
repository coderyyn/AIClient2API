import { EventEmitter } from 'node:events';
import { handleUnaryRequest, handleStreamRequest, applyProviderRateLimitCooldown } from '../src/utils/common.js';
import { createProviderRpmError } from '../src/runtime/provider-rpm.js';
import requestContext from '../src/utils/context.js';
import { getApiServiceWithFallback } from '../src/services/service-manager.js';
jest.mock('../src/services/service-manager.js', () => ({ getApiServiceWithFallback: jest.fn() }));
class Response extends EventEmitter {
    constructor() { super(); this.body = ''; this.headers = {}; }
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); this.headersSent = true; }
    setHeader(key, value) { this.headers[key] = value; }
    write(data) { this.body += String(data); return true; }
    end(data = '') { this.body += String(data); this.writableEnded = true; }
}
const error = () => createProviderRpmError({ limit: 180, used: 180, retryAfterMs: 1501 });
function manager() {
    return { releaseSlot: jest.fn(), markProviderUnhealthy: jest.fn(), markProviderHealthy: jest.fn(),
        markProviderUnhealthyImmediately: jest.fn(), markProviderUnhealthyWithRecoveryTime: jest.fn(),
        markCodexRateLimitCooldown: jest.fn() };
}
afterEach(() => jest.clearAllMocks());
test.each([false, true])('no capacity returns real HTTP 429 without marking account unhealthy (stream=%s)', async stream => {
    const res = new Response(), pool = manager();
    const service = { generateContent: async () => { throw error(); },
        generateContentStream: async function* () { throw error(); } };
    getApiServiceWithFallback.mockResolvedValue(null);
    const store = { requestAudit: {} };
    await requestContext.run(store, () => (stream ? handleStreamRequest : handleUnaryRequest)(
        res, service, 'gpt-5.5', { input: 'test' }, 'openai-codex-oauth', 'openai-codex-oauth',
        'none', null, pool, 'a', null, { CONFIG: {} }));
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.body).toContain('PROVIDER_RPM_LIMIT_EXCEEDED');
    expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
    expect(pool.markCodexRateLimitCooldown).not.toHaveBeenCalled();
    expect(pool.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'a');
    expect(getApiServiceWithFallback).toHaveBeenCalledWith({}, 'gpt-5.5', expect.objectContaining({
        excludeProviderUuids: ['a'], allowExcludedProviderFallback: false, disableProviderFallback: true
    }));
    expect(store.requestAudit.terminal.errorClass).toBe('PROVIDER_RPM_LIMIT_EXCEEDED');
});
test('cooldown helper explicitly excludes local RPM', () => {
    const pool = manager();
    expect(applyProviderRateLimitCooldown({ error: error(), providerPoolManager: pool,
        providerType: 'openai-codex-oauth', providerUuid: 'a', requestedModel: 'gpt-5.5' })).toBe(false);
    expect(pool.markCodexRateLimitCooldown).not.toHaveBeenCalled();
});


test('switches to another authorized candidate without a retry loop or health penalty', async () => {
    const res = new Response(), pool = manager();
    const first = { generateContent: async () => { throw error(); } };
    const second = { generateContent: async () => ({ type: 'response.completed', response: {
        id: 'rpm-switch-success', model: 'gpt-6-sol', output: [] } }) };
    getApiServiceWithFallback.mockResolvedValue({ service: second, uuid: 'b', actualProviderType: 'openai-codex-oauth', serviceConfig: {} });
    const store = { requestAudit: {} };
    await requestContext.run(store, () => handleUnaryRequest(res, first, 'gpt-6-sol', { input: 'test' },
        'openai-codex-oauth', 'openai-codex-oauth', 'none', null, pool, 'a', null, { CONFIG: {} }));
    expect(res.body).toContain('rpm-switch-success');
    expect(res.statusCode).toBe(200);
    expect(getApiServiceWithFallback).toHaveBeenCalledTimes(1);
    expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
    expect(store.requestAudit.providerRpmRejections).toHaveLength(1);
});
