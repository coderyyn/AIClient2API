import { Readable } from 'stream';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    getApiServiceWithFallback: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => ({
        executeHook: jest.fn(async () => undefined)
    }))
}));

import '../src/converters/register-converters.js';
import { handleAPIRequests } from '../src/services/api-manager.js';

function makeJsonRequest(path, body) {
    const payload = Buffer.from(JSON.stringify(body));
    const req = Readable.from(payload);
    req.method = 'POST';
    req.url = path;
    req.headers = {
        host: 'localhost:3000',
        'content-type': 'application/json',
        'content-length': String(payload.length)
    };
    req.complete = true;
    return req;
}

function makeResponse() {
    return {
        statusCode: null,
        headers: {},
        body: '',
        writableEnded: false,
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(body = '') {
            this.body = body;
            this.writableEnded = true;
        }
    };
}

describe('Gemini native Banana2 image contract', () => {
    test('passes official imageConfig and multiple inlineData parts without OpenAI-only fields', async () => {
        const requestBody = {
            contents: [{
                role: 'user',
                parts: [
                    { text: '合并两张图片，背景改为草地。' },
                    { inlineData: { mimeType: 'image/png', data: 'Zmlyc3QtaW1hZ2U=' } },
                    { inlineData: { mimeType: 'image/jpeg', data: 'c2Vjb25kLWltYWdl' } }
                ]
            }],
            generationConfig: {
                responseModalities: ['IMAGE'],
                imageConfig: {
                    aspectRatio: '16:9',
                    imageSize: '2K'
                }
            }
        };
        const nativeResponse = {
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{ inlineData: { mimeType: 'image/png', data: 'cmVzdWx0LWltYWdl' } }]
                },
                finishReason: 'STOP'
            }]
        };
        const service = {
            generateContent: jest.fn(async () => nativeResponse)
        };
        const path = '/v1beta/models/gemini-3.1-flash-image:generateContent';
        const req = makeJsonRequest(path, requestBody);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            path,
            req,
            res,
            {
                MODEL_PROVIDER: 'gemini-antigravity',
                REQUEST_BODY_MAX_BYTES: 2 * 1024 * 1024,
                PROMPT_LOG_MODE: 'none'
            },
            service,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(service.generateContent).toHaveBeenCalledTimes(1);
        const [model, forwardedBody] = service.generateContent.mock.calls[0];
        expect(model).toBe('gemini-3.1-flash-image');
        expect(forwardedBody.contents[0].parts).toEqual(requestBody.contents[0].parts);
        expect(forwardedBody.generationConfig).toEqual(requestBody.generationConfig);
        expect(forwardedBody).not.toHaveProperty('size');
        expect(forwardedBody).not.toHaveProperty('image_config');
        expect(forwardedBody).not.toHaveProperty('extra_body');

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual(nativeResponse);
        expect(JSON.parse(res.body).candidates[0].content.parts[0].inlineData).toEqual({
            mimeType: 'image/png',
            data: 'cmVzdWx0LWltYWdl'
        });
    });
});
