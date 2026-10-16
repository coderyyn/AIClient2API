import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { parseCodexSafetyBuffering } from '../src/providers/openai/codex-safety-buffering.js';
import { getRequestAttempts } from '../src/utils/request-attempts.js';
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';
import { RequestAuditStore } from '../src/plugins/request-audit/audit-store.js';
import { GptRequestStore } from '../src/plugins/request-audit/gpt-request-store.js';
import { RuntimeHookBridge } from '../src/runtime/runtime-hook-bridge.js';
import { safetyBufferingDifference, safetyBufferingHtml, groupedSafetyBufferingHtml } from '../static/app/codex-safety-buffering.js';

jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({ configureTLSSidecar: jest.fn(c => c), isTLSSidecarEnabledForProvider: () => false, getProxyConfigForProvider: () => null }));

const headers = { 'X-Codex-Safety-Buffering-Enabled': ' TRUE ', 'X-Codex-Safety-Buffering-Faster-Model': ' gpt-6-luna ' };
const signal = { enabled: true, fasterModel: 'gpt-6-luna' };
const services = [];
function service() {
    const s = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', CODEX_OVERLOAD_RETRY_MAX_ATTEMPTS: 0 });
    s.isInitialized = true;
    s.expiresAt = new Date(Date.now() + 3600000);
    services.push(s);
    return s;
}
afterEach(() => { axios.request.mockReset(); services.splice(0).forEach(s => s.stopCacheCleanup()); });

test('parses case insensitive allowlisted headers and rejects malformed values', () => {
    expect(parseCodexSafetyBuffering(headers)).toEqual(signal);
    expect(parseCodexSafetyBuffering(new Headers({ 'x-codex-safety-buffering-enabled': 'false' }))).toEqual({ enabled: false, fasterModel: null });
    for (const raw of [undefined, {}, { 'x-codex-safety-buffering-enabled': 'yes', 'x-codex-safety-buffering-faster-model': ['gpt-6-luna'] }, { 'x-codex-safety-buffering-faster-model': '<img onerror=alert(1)>' }]) {
        expect(parseCodexSafetyBuffering(raw)).toEqual({ enabled: null, fasterModel: null });
    }
});

test.each([false, true])('captures headers before stream/unary failure and does not reuse them: stream=%s', async stream => {
    const s = service();
    const failed = { type: 'response.failed', response: { error: { type: 'invalid_request_error', message: 'fixture failure' } } };
    const done = { type: 'response.completed', response: { model: 'gpt-6-astra', status: 'completed', output: [] } };
    const payload = event => stream ? Readable.from([`data: ${JSON.stringify(event)}\n\n`]) : `data: ${JSON.stringify(event)}\n\n`;
    axios.request.mockResolvedValueOnce({ status: 200, headers, data: payload(failed) }).mockResolvedValueOnce({ status: 200, headers: {}, data: payload(done) });
    const body = { input: 'fixture' };
    const invoke = async () => { if (stream) { for await (const unused of s.generateContentStream('gpt-6-astra', body)) { void unused; } } else await s.generateContent('gpt-6-astra', body); };
    await expect(invoke()).rejects.toThrow();
    await invoke();
    const attempts = getRequestAttempts(body);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ status: 'error', codexSafetyBuffering: signal });
    expect(attempts[1]).toMatchObject({ status: 'success', codexSafetyBuffering: { enabled: null, fasterModel: null }, upstreamResponseModel: 'gpt-6-astra' });
});

test('captures rejected HTTP response headers, but not network failures without a response', async () => {
    const s = service();
    const body = { input: 'fixture' };
    axios.request.mockRejectedValueOnce(Object.assign(new Error('fixture'), { response: { status: 400, headers, data: {} } }));
    await expect(s.generateContent('gpt-6-astra', body)).rejects.toThrow();
    expect(getRequestAttempts(body)[0].codexSafetyBuffering).toEqual(signal);
    axios.request.mockRejectedValueOnce(new Error('network fixture'));
    await expect(s.generateContent('gpt-6-astra', body)).rejects.toThrow();
    expect(getRequestAttempts(body)[1]).not.toHaveProperty('codexSafetyBuffering');
});

test.each([false, true])('automatic same-credential retry isolates signals: stream=%s', async stream => {
    const s = service();
    s.config.CODEX_RATE_LIMIT_RETRY_DELAY_MS = 0;
    const done = { type: 'response.completed', response: { model: 'gpt-6-astra', status: 'completed', output: [] } };
    axios.request.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { response: { status: 429, headers: { ...headers, 'retry-after': '0' }, data: {} } }))
        .mockResolvedValueOnce({ status: 200, headers: {}, data: stream ? Readable.from([`data: ${JSON.stringify(done)}\n\n`]) : `data: ${JSON.stringify(done)}\n\n` });
    const body = { input: 'fixture' };
    if (stream) { for await (const unused of s.generateContentStream('gpt-6-astra', body)) { void unused; } }
    else await s.generateContent('gpt-6-astra', body);
    expect(axios.request).toHaveBeenCalledTimes(2);
    expect(getRequestAttempts(body).map(a => a.codexSafetyBuffering)).toEqual([signal, { enabled: null, fasterModel: null }]);
});

test('survives worker transport and store roundtrip, with summary from last credential attempt only', async () => {
    const published = [];
    const bridge = new RuntimeHookBridge({ send: jest.fn(), durableTransport: { publish: event => published.push(JSON.parse(JSON.stringify(event))), snapshot: () => ({}) } });
    const attempts = [{ providerType: 'openai-codex-oauth', providerUuid: 'first', outboundModel: 'gpt-6-astra', status: 'error', codexSafetyBuffering: signal },
        { providerType: 'openai-codex-oauth', providerUuid: 'second', outboundModel: 'gpt-6-astra', upstreamResponseModel: 'gpt-6-astra', status: 'success', codexSafetyBuffering: { enabled: false, fasterModel: 'gpt-6-astra' } }];
    await bridge.handle('onRequestCompleted', { requestId: 'buffering-fixture', toProvider: 'openai-codex-oauth', requestAttempts: attempts });
    const event = buildRequestAuditEvent(published[0].args[0]);
    expect(event.attempts[0].codexSafetyBuffering).toEqual(signal);
    expect(event.request.codexSafetyBuffering).toEqual(attempts[1].codexSafetyBuffering);
    expect(event.request.modelMismatch).toBe(false);
    expect(safetyBufferingDifference(event.request)).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-buffering-'));
    try {
        const store = new RequestAuditStore({ dir });
        await store.append(event);
        expect((await store.query({ requestId: event.requestId }))[0].attempts).toEqual(event.attempts);
        const sqlite = await new GptRequestStore({ dbPath: path.join(dir, 'gpt.sqlite') }).init();
        try {
            sqlite.append(event);
            const loaded = sqlite.query({}).requests.find(item => item.requestId === event.requestId);
            expect(loaded.request.codexSafetyBuffering).toEqual(attempts[1].codexSafetyBuffering);
            expect(loaded.attempts).toEqual(event.attempts);
        } finally { sqlite.close(); }
    } finally { fs.rmSync(dir, { recursive: true }); }
    const legacy = buildRequestAuditEvent({ requestAttempts: [{ providerType: 'openai-codex-oauth' }] });
    expect(legacy.request).not.toHaveProperty('codexSafetyBuffering');
    expect(buildRequestAuditEvent({ requestAttempts: [{ providerType: 'openai-custom', codexSafetyBuffering: signal }] }).request).not.toHaveProperty('codexSafetyBuffering');
});

test('renders only differences, preserves speed tiers, groups evidence, and escapes HTML', () => {
    const probe = { outboundModel: ' gpt-6-astra ', responseModel: 'gpt-6-astra', codexSafetyBuffering: signal };
    expect(safetyBufferingHtml(probe)).toContain('响应头模型存在差异');
    expect(groupedSafetyBufferingHtml([probe, probe])).toContain('（2 次）');
    for (const evidence of [{}, { codexSafetyBuffering: signal }, { outboundModel: 'gpt-6-astra' }, { outboundModel: 'gpt-6-luna', codexSafetyBuffering: signal }]) expect(safetyBufferingHtml(evidence)).toBe('');
    expect(safetyBufferingDifference({ outboundModel: 'gpt-6-luna-fast', codexSafetyBuffering: signal })).not.toBeNull();
    expect(safetyBufferingDifference({ outboundModel: 'gpt-6-luna', responseModel: 'gpt-6-astra', codexSafetyBuffering: { ...signal, enabled: false } })).not.toBeNull();
    expect(safetyBufferingHtml({ ...probe, codexSafetyBuffering: { ...signal, fasterModel: '<img>' } })).toContain('&lt;img&gt;');
});
