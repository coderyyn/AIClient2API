import http from 'node:http';
import { once } from 'node:events';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const services = [], servers = [];
async function setup(handler) {
    const server = http.createServer(handler);
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const service = new AntigravityApiService({ MODEL_PROVIDER: 'gemini-antigravity', PROJECT_ID: 'test-project',
        ANTIGRAVITY_BASE_URL: `http://127.0.0.1:${server.address().port}` });
    services.push(service);
    service.loadCredentials = async () => { service.authClient.setCredentials({ access_token: 'synthetic-probe-token' }); };
    service._applySidecar = options => options;
    service.initialize = () => { throw new Error('Must not initialize or discover models'); };
    return service;
}
afterEach(async () => {
    for (const s of services.splice(0)) { s.httpAgent.destroy(); s.httpsAgent.destroy(); }
    for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
});
const body = () => ({ contents: [{ role: 'user', parts: [{ text: 'synthetic probe' }] }], generationConfig: { maxOutputTokens: 256 } });

test('single outbound request preserves target model, output cap and upstream completion', async () => {
    const seen = [];
    const service = await setup(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        seen.push({ url: req.url, payload: JSON.parse(raw) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ response: { modelVersion: 'gemini-2.5-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '43' }] } }] } }));
    });
    const result = await service.probeCooldownModel('gemini-2.5-flash', body(), { signal: new AbortController().signal, timeoutMs: 1000 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1internal:generateContent');
    assert.equal(seen[0].payload.model, 'gemini-2.5-flash');
    assert.equal(seen[0].payload.request.generationConfig.maxOutputTokens, 256);
    assert.equal(result.response.candidates[0].finishReason, 'STOP');
});

for (const status of [429, 500, 401]) test(`HTTP ${status} is surfaced once without retry or OAuth replay`, async () => {
    let count = 0;
    const service = await setup((req, res) => { count++; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'synthetic failure' } })); });
    await assert.rejects(service.probeCooldownModel('gemini-2.5-flash', body(), { signal: new AbortController().signal, timeoutMs: 1000 }), error => error.response?.status === status);
    assert.equal(count, 1);
});

test('abort closes a live image SSE connection after the first parsed chunk', async () => {
    let parsed, closed;
    const parsedPromise = new Promise(resolve => { parsed = resolve; });
    const closedPromise = new Promise(resolve => { closed = resolve; });
    const service = await setup((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"response":{"candidates":[{"content":{"parts":[{"text":"working"}]}}]}}\n\n');
        res.on('close', closed);
    });
    const parse = service.parseSSEStream.bind(service);
    service.parseSSEStream = async function* (stream) {
        for await (const chunk of parse(stream)) { parsed(); yield chunk; }
    };
    const controller = new AbortController();
    const request = service.probeCooldownModel('gemini-3.1-flash-image', body(), { signal: controller.signal, timeoutMs: 2000 });
    const rejection = assert.rejects(request);
    await parsedPromise; controller.abort(); await rejection; await closedPromise;
});

test('image SSE aggregation retains inline image, model and terminal reason', async () => {
    const service = await setup((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: '+ JSON.stringify({ response: { modelVersion: 'gemini-3.1-flash-image', candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'synthetic' } }] }, finishReason: 'STOP' }] } }) + '\n\n');
    });
    const r = await service.probeCooldownModel('gemini-3.1-flash-image', body(), { signal: new AbortController().signal, timeoutMs: 1000 });
    assert.equal(r.response.modelVersion, 'gemini-3.1-flash-image');
    assert.equal(r.response.candidates[0].finishReason, 'STOP');
    assert.equal(r.response.candidates[0].content.parts[0].inlineData.data, 'synthetic');
});
