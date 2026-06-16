import { jest } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

import logger from '../src/utils/logger.js';
import aiMonitorPlugin from '../src/plugins/ai-monitor/index.js';

function flushImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

describe('ai-monitor log sanitization', () => {
    const imageBase64 = Buffer.alloc(512, 7).toString('base64');
    const imageDataUri = `data:image/png;base64,${imageBase64}`;

    beforeEach(() => {
        logger.info.mockClear();
        logger.warn.mockClear();
        logger.error.mockClear();
        logger.debug.mockClear();
        aiMonitorPlugin.streamCache.clear();
    });

    test('redacts image payloads in unary response logs', async () => {
        await aiMonitorPlugin.hooks.onUnaryResponse({
            nativeResponse: {
                response: {
                    output: [{
                        type: 'image_generation_call',
                        result: imageBase64,
                        output_format: 'png'
                    }]
                }
            },
            clientResponse: {
                created: 1780999675,
                data: [{
                    b64_json: imageBase64,
                    revised_prompt: 'one green circle'
                }]
            },
            fromProvider: 'openai',
            toProvider: 'openai-codex-oauth',
            requestId: 'req-image'
        });

        await flushImmediate();

        const logged = logger.info.mock.calls.map(([message]) => String(message)).join('\n');
        expect(logged).not.toContain(imageBase64);
        expect(logged).toContain('"kind":"base64"');
        expect(logged).toContain(`"chars":${imageBase64.length}`);
    });

    test('redacts image data uris in internal converted request logs', async () => {
        await aiMonitorPlugin.hooks.onInternalRequestConverted({
            requestId: 'req-edit',
            converterName: 'test-converter',
            internalRequest: {
                model: 'gpt-image-2',
                input: [{
                    type: 'message',
                    role: 'user',
                    content: [{
                        type: 'input_image',
                        image_url: imageDataUri
                    }]
                }]
            }
        });

        await flushImmediate();

        const logged = logger.info.mock.calls.map(([message]) => String(message)).join('\n');
        expect(logged).not.toContain(imageBase64);
        expect(logged).not.toContain(imageDataUri);
        expect(logged).toContain('"kind":"data-uri"');
        expect(logged).toContain('"media_type":"image/png"');
    });
});
