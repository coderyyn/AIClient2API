import { EventEmitter } from 'node:events';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));
jest.mock('../src/auth/oauth-handlers.js', () => ({
    handleGeminiAntigravityOAuth: jest.fn()
}));
jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { handleStreamRequest } from '../src/utils/common.js';
import '../src/converters/register-converters.js';

function createResponse() {
    const response = new EventEmitter();
    response.writableEnded = false;
    response.writeHead = jest.fn();
    response.write = jest.fn(() => true);
    response.end = jest.fn(function end() {
        this.writableEnded = true;
    });
    return response;
}

function createPool() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        releaseSlot: jest.fn()
    };
}

// Real Antigravity stream normalization over a stubbed transport of native envelopes.
function createService(envelopes) {
    const service = Object.create(AntigravityApiService.prototype);
    service.isInitialized = true;
    service.availableModels = ['gemini-3.8-flash-high'];
    service.authClient = { credentials: { expiry_date: Date.now() + 60_000 } };
    service.prepareRequestMetadata = jest.fn();
    service.buildAntigravityPayload = jest.fn(() => ({ payload: {} }));
    service.streamApi = jest.fn(async function* stream() {
        yield* envelopes;
    });
    jest.spyOn(service, 'generateContentStream');
    return service;
}

async function runStream(envelopes, { maxRetries = 0 } = {}) {
    const response = createResponse();
    const pool = createPool();
    const service = createService(envelopes);
    await handleStreamRequest(response, service, 'gemini-3.8-flash-high', {}, 'openai', 'gemini-antigravity',
        'none', null, pool, 'test-account', null, { CONFIG: {}, maxRetries });
    const written = response.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    return { pool, service, written };
}

const text = (value, finishReason) => ({
    response: {
        candidates: [{
            content: { role: 'model', parts: [{ text: value }] },
            ...(finishReason ? { finishReason } : {})
        }]
    }
});

describe('Antigravity stream completion contract', () => {
    test('a stream with a finish reason completes and records success', async () => {
        const { pool, written } = await runStream([text('hello'), { traceId: 'heartbeat' }, text(' world', 'STOP')]);
        expect(written).toContain('hello');
        expect(written).not.toContain('INCOMPLETE_UPSTREAM_STREAM');
        expect(pool.markProviderHealthy).toHaveBeenCalled();
    });

    test('EOF without a finish reason keeps partial output and ends with an explicit error', async () => {
        const { pool, written } = await runStream([text('partial')]);
        expect(written).toContain('partial');
        expect(written).toContain('INCOMPLETE_UPSTREAM_STREAM');
        expect(pool.markProviderHealthy).not.toHaveBeenCalled();
    });

    test('a blocked prompt is a content filter, not a credential failure', async () => {
        const blocked = { response: { promptFeedback: { blockReason: 'SAFETY' } } };
        const { pool, service, written } = await runStream([blocked], { maxRetries: 3 });
        expect(service.generateContentStream).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(written).toContain('content_filter');
    });
});
