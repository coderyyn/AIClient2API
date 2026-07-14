import { Readable } from 'node:stream';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

const services = [];

function createService() {
    const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });
    services.push(service);
    return service;
}

function failedEvent(error) {
    return {
        type: 'response.failed',
        response: { error }
    };
}

async function consumeStream(generator) {
    const events = [];
    for await (const event of generator) {
        events.push(event);
    }
    return events;
}

afterEach(() => {
    while (services.length > 0) {
        services.pop().stopCacheCleanup();
    }
});

describe('Codex terminal Responses errors', () => {
    test('preserves response.failed invalid request details as a 400 error', () => {
        const service = createService();
        const payload = failedEvent({
            type: 'invalid_request_error',
            code: 'invalid_request_error',
            message: 'A hosted tool conflicts with a function tool.'
        });

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(payload));
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toContain('A hosted tool conflicts with a function tool.');
        expect(thrown.response).toEqual(expect.objectContaining({ status: 400 }));
        expect(thrown.shouldSwitchCredential).not.toBe(true);
        expect(thrown.skipErrorCount).not.toBe(true);
    });

    test('maps usage_limit_reached to retryable credential-switch metadata', () => {
        const service = createService();
        const payload = failedEvent({
            type: 'usage_limit_reached',
            message: 'The usage limit has been reached.',
            resets_in_seconds: 37
        });

        let thrown;
        try {
            service.parseNonStreamResponse(`data:${JSON.stringify(payload)}`);
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(429);
        expect(thrown.shouldSwitchCredential).toBe(true);
        expect(thrown.skipErrorCount).toBe(true);
        expect(thrown.retryAfterMs).toBe(37000);
    });

    test.each([
        'The selected model is at capacity.',
        'Model is at capacity. Please try a different model.'
    ])('maps model capacity to credential-switch metadata: %s', (message) => {
        const service = createService();

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(failedEvent({ message })));
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(429);
        expect(thrown.shouldSwitchCredential).toBe(true);
        expect(thrown.skipErrorCount).toBe(true);
    });

    test('parses data without a space and throws the final response.failed buffer', async () => {
        const service = createService();
        const payload = failedEvent({
            type: 'invalid_request_error',
            message: 'Final buffer failure'
        });
        const stream = Readable.from([
            'event: response.failed\n',
            'id: evt_1\n',
            'retry: 1000\n',
            `data:${JSON.stringify(payload)}`
        ]);

        await expect(consumeStream(service.parseSSEStream(stream))).rejects.toMatchObject({
            message: expect.stringContaining('Final buffer failure'),
            response: expect.objectContaining({ status: 400 })
        });
    });

    test('accepts a bare JSON completed event in the streaming parser', async () => {
        const service = createService();
        const completed = {
            type: 'response.completed',
            response: { id: 'resp_1', output: [] }
        };
        const stream = Readable.from([`${JSON.stringify(completed)}\n`]);

        await expect(consumeStream(service.parseSSEStream(stream))).resolves.toEqual([completed]);
    });
});
