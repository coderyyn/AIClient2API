import { PassThrough, Readable } from 'stream';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

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

import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

async function collect(iterable) {
    const items = [];
    for await (const item of iterable) items.push(item);
    return items;
}

function createService(overrides = {}) {
    return new AntigravityApiService({
        MODEL_PROVIDER: 'gemini-antigravity',
        ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
        PROJECT_ID: 'test-project',
        ...overrides
    });
}

describe('Gemini and Antigravity streaming fixes from upstream v3.3.9', () => {
    test('keeps a stream chunk that only contains thoughtSignature', () => {
        const converter = new GeminiConverter();
        const result = converter.toOpenAIStreamChunk({
            candidates: [{
                content: { parts: [{ thoughtSignature: 'internal-signature' }] }
            }]
        }, 'gemini-3-flash');

        expect(result).not.toBeNull();
        expect(result.choices[0].delta).toEqual({});
        expect(result.choices[0].finish_reason).toBeNull();
    });

    test('recovers a non-SSE JSON array response', async () => {
        const service = createService({ ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS: 1000 });
        const upstreamChunks = [
            { response: { candidates: [{ index: 0 }] } },
            { response: { candidates: [{ index: 1 }] } }
        ];
        const stream = Readable.from([JSON.stringify(upstreamChunks, null, 2)]);

        await expect(collect(service.parseSSEStream(stream))).resolves.toEqual(upstreamChunks);
    });

    test('fails a stream that remains idle', async () => {
        const service = createService({ ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS: 20 });
        const stream = new PassThrough();

        await expect(collect(service.parseSSEStream(stream))).rejects.toMatchObject({
            code: 'ETIMEDOUT'
        });
    });
});
