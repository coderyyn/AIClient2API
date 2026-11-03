import { jest, test, expect, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';
import axios from 'axios';
import requestContext from '../src/utils/context.js';
import { OpenAIResponsesApiService } from '../src/providers/openai/openai-responses-core.js';
import { getRequestAttempts } from '../src/utils/request-attempts.js';
jest.mock('axios', () => ({ create: jest.fn() }));
jest.mock('../src/utils/proxy-utils.js', () => ({ configureTLSSidecar: c => c }));
const model = 'gpt-6-sol';
function setup() {
    const request = jest.fn();axios.create.mockReturnValue({ request });
    const live = { uuid: 'api-key', supportedModels: [model], isHealthy: true };
    const state = { manager: { _findProvider: () => ({ config: live }) }, selection: { providerType: 'openaiResponses-custom', uuid: live.uuid, model } };
    const service = new OpenAIResponsesApiService({ uuid: live.uuid, OPENAI_API_KEY: 'fixture-only', REQUEST_BASE_DELAY: 1, REQUEST_MAX_RETRIES: 2 });
    return { request, live, state, service };
}
const quotaError = code => Object.assign(new Error('upstream rejection'), { response: { status: 429, data: { error: { code } } } });
test('every internal 429 retry is audited as a separate actual send', async () => {
    const { request, state, service } = setup();
    request.mockRejectedValueOnce(quotaError('rate_limit_exceeded')).mockResolvedValue({ status: 200, data: { id: 'response-test', object: 'response', model, output: [] } });
    const body = { model, input: 'fixture' };
    await requestContext.run({ gptMixedState: state, gptRequestPolicy: { model } }, async () => {
        await service.generateContent(model, body);
        expect(getRequestAttempts(body).map(a => a.httpStatus)).toEqual([429, 200]);
    });
    expect(request).toHaveBeenCalledTimes(2);
});
test('disabling a credential during backoff prevents a second send', async () => {
    const { request, state, live, service } = setup();
    request.mockImplementationOnce(() => { live.isDisabled = true;return Promise.reject(quotaError('rate_limit_exceeded')); });
    await requestContext.run({ gptMixedState: state, gptRequestPolicy: { model } }, async () => {
        await expect(service.generateContent(model, { model, input: 'fixture' })).rejects.toMatchObject({ code: 'PROVIDER_POLICY_CHANGED' });
    });
    expect(request).toHaveBeenCalledTimes(1);
});
test('credit exhaustion does not retry the same Key internally', async () => {
    const { request, state, service } = setup();request.mockRejectedValue(quotaError('credit_balance_exhausted'));
    await requestContext.run({ gptMixedState: state, gptRequestPolicy: { model } }, async () => {
        await expect(service.generateContent(model, { model, input: 'fixture' })).rejects.toMatchObject({ response: { status: 429 } });
    });
    expect(request).toHaveBeenCalledTimes(1);
});
test('streaming attempts are audited and preserve response events', async () => {
    const { request, state, service } = setup();
    request.mockResolvedValue({ status: 200, data: Readable.from(['data: {"type":"response.created","response":{"id":"resp-stream"}}\n\ndata: {"type":"response.completed","response":{"id":"resp-stream"}}\n\ndata: [DONE]\n']) });
    const body = { model, input: 'fixture' };
    await requestContext.run({ gptMixedState: state, gptRequestPolicy: { model } }, async () => {
        const events = [];for await(const event of service.generateContentStream(model, body)) events.push(event);
        expect(events.map(e => e.type)).toEqual(['response.created','response.completed']);
        expect(getRequestAttempts(body)).toHaveLength(1);expect(getRequestAttempts(body)[0]).toMatchObject({ httpStatus: 200, status: 'success' });
    });
});

test('a stream failure after output does not send a second upstream request', async () => {
    const { request, state, service } = setup();
    const stream = Readable.from((async function* () {
        yield 'data: {"type":"response.created","response":{"id":"resp-partial"}}\n\n';
        throw new Error('fixture stream interrupted');
    })());
    request.mockResolvedValue({ status: 200, data: stream });
    const body = { model, input: 'fixture' };
    await requestContext.run({ gptMixedState: state, gptRequestPolicy: { model } }, async () => {
        await expect((async () => {
            for await (const event of service.generateContentStream(model, body)) { /* consume */ }
        })()).rejects.toThrow('fixture stream interrupted');
        expect(getRequestAttempts(body)).toHaveLength(1);
        expect(getRequestAttempts(body)[0].status).toBe('error');
    });
    expect(request).toHaveBeenCalledTimes(1);
});

test('closing an unfinished stream finalizes the actual attempt as interrupted', async () => {
    const { request, state, service } = setup();
    request.mockResolvedValue({ status: 200, data: Readable.from(['data: {"type":"response.created","response":{"id":"resp-close"}}\n\n']) });
    const body = { model, input: 'fixture' };
    await requestContext.run({ gptMixedState: state, gptRequestPolicy: { model } }, async () => {
        for await (const event of service.generateContentStream(model, body)) break;
        expect(getRequestAttempts(body)[0]).toMatchObject({ status: 'error', errorCode: 'UPSTREAM_STREAM_INTERRUPTED' });
    });
});
