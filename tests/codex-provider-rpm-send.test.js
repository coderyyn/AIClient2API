import { Readable } from 'node:stream';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { getProviderPoolManager } from '../src/services/service-manager.js';
import { getRequestAttempts } from '../src/utils/request-attempts.js';

jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config), isTLSSidecarEnabledForProvider: () => false,
    getProxyConfigForProvider: () => null
}));
const services = [];
afterEach(() => { services.splice(0).forEach(s => s.stopCacheCleanup()); jest.clearAllMocks(); });
function setup(limit = 1) {
    const config = { MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'a', rpmLimit: limit,
        CODEX_OVERLOAD_RETRY_DELAY_MS: 0, CODEX_RATE_LIMIT_RETRY_DELAY_MS: 0 };
    let used = 0;
    const live = { ...config };
    const coordination = { _eval: jest.fn(async () => {
        const allowed = used < live.rpmLimit;
        if (allowed) used++;
        return { allowed, used, limit: live.rpmLimit, retryAfterMs: allowed ? 0 : 50000 };
    }) };
    getProviderPoolManager.mockReturnValue({ coordination, providerStatus: { 'openai-codex-oauth': [{ config: live }] } });
    const service = new CodexApiService(config);
    services.push(service);
    service.isInitialized = true;
    service.accessToken = 'test-placeholder';
    service.accountId = 'test-account';
    return { service, live, coordination };
}
async function consume(service, body, stream) {
    if (!stream) return service.generateContent('gpt-6-sol', body);
    for await (const _event of service.generateContentStream('gpt-6-sol', body)) { /* consume */ }
}
test.each([false, true])('overload retry consumes a new permit; local refusal is not an upstream attempt (stream=%s)', async stream => {
    const { service, coordination } = setup(1);
    const failure = { type: 'response.failed', response: { error: { code: 'server_is_overloaded',
        type: 'service_unavailable_error', message: 'Our servers are currently overloaded. Please try again later.' } } };
    const data = `data:${JSON.stringify(failure)}\n`;
    axios.request.mockResolvedValue({ status: 200, data: stream ? Readable.from([data]) : data });
    const body = { input: 'test' };
    await expect(consume(service, body, stream)).rejects.toMatchObject({ code: 'PROVIDER_RPM_LIMIT_EXCEEDED', origin: 'local_provider_rpm' });
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(coordination._eval).toHaveBeenCalledTimes(2);
    expect(getRequestAttempts(body)).toHaveLength(1);
});
test.each([false, true])('initial refusal sends nothing; live updates override cached adapter (stream=%s)', async stream => {
    const { service, live, coordination } = setup(10);
    live.rpmLimit = 1;
    await service.consumeProviderRpm();
    const body = { input: 'test' };
    await expect(consume(service, body, stream)).rejects.toMatchObject({ status: 429 });
    expect(axios.request).not.toHaveBeenCalled();
    expect(getRequestAttempts(body)).toHaveLength(0);
    live.rpmLimit = 0;
    await service.consumeProviderRpm();
    expect(coordination._eval).toHaveBeenCalledTimes(2);
});


test.each([false, true])('upstream 429 retry is counted before a second wire request (stream=%s)', async stream => {
    const { service, coordination } = setup(1);
    const upstream = Object.assign(new Error('rate limit'), { response: { status: 429,
        headers: { 'retry-after': '0' }, data: { error: { code: 'rate_limit_exceeded' } } } });
    axios.request.mockRejectedValue(upstream);
    const body = { input: 'test' };
    await expect(consume(service, body, stream)).rejects.toMatchObject({ code: 'PROVIDER_RPM_LIMIT_EXCEEDED' });
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(coordination._eval).toHaveBeenCalledTimes(2);
    expect(getRequestAttempts(body)).toHaveLength(1);
});

test.each([false, true])('disabled RPM leaves actual model sending unchanged (stream=%s)', async stream => {
    const { service, coordination } = setup(0);
    const completed = { type: 'response.completed', response: { id: 'test', model: 'gpt-6-sol', output: [] } };
    const data = `data:${JSON.stringify(completed)}\n`;
    axios.request.mockResolvedValue({ status: 200, data: stream ? Readable.from([data]) : data });
    await consume(service, { input: 'test' }, stream);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(coordination._eval).not.toHaveBeenCalled();
});
