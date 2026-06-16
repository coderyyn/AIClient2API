import { Readable } from 'stream';
import { jest } from '@jest/globals';
import '../src/converters/register-converters.js';
import { handleAPIRequests } from '../src/services/api-manager.js';

const mockGenerateContent = jest.fn();

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    getApiServiceWithFallback: jest.fn(async () => ({
        service: { generateContent: mockGenerateContent },
        actualProviderType: 'openai-codex-oauth'
    }))
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

import logger from '../src/utils/logger.js';

function makeMultipartRequest(parts) {
    const boundary = '----aiclient2api-test-boundary';
    const chunks = [];

    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.file) {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                `Content-Type: ${part.contentType}\r\n\r\n`
            ));
            chunks.push(Buffer.from(part.value));
            chunks.push(Buffer.from('\r\n'));
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`
            ));
        }
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);
    const req = Readable.from(body);
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length)
    };
    req.complete = true;
    return req;
}

function makeJsonRequest(body) {
    const payload = Buffer.from(JSON.stringify(body));
    const req = Readable.from(payload);
    req.headers = {
        'content-type': 'application/json',
        'content-length': String(payload.length)
    };
    req.complete = true;
    return req;
}

function makeResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writableEnded: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(body = '') {
            this.body = body;
            this.writableEnded = true;
        }
    };
}

describe('/v1/images/edits multipart handling', () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        logger.info.mockClear();
        logger.warn.mockClear();
        logger.error.mockClear();
        logger.debug.mockClear();
        mockGenerateContent.mockResolvedValue({
            response: {
                output: [{
                    type: 'image_generation_call',
                    result: 'generated-image-b64',
                    output_format: 'png'
                }]
            }
        });
    });

    test('preserves multiple image[] files as multiple Codex input_image parts', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image[]', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' },
            { name: 'image[]', file: true, filename: 'second.png', contentType: 'image/png', value: 'second-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageParts = requestBody.input[0].content.filter(part => part.type === 'input_image');

        expect(imageParts).toHaveLength(2);
        expect(imageParts[0].image_url).toContain(Buffer.from('first-image').toString('base64'));
        expect(imageParts[1].image_url).toContain(Buffer.from('second-image').toString('base64'));
    });

    test('preserves multiple image files as multiple Codex input_image parts', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' },
            { name: 'image', file: true, filename: 'second.png', contentType: 'image/png', value: 'second-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageParts = requestBody.input[0].content.filter(part => part.type === 'input_image');

        expect(imageParts).toHaveLength(2);
        expect(imageParts[0].image_url).toContain(Buffer.from('first-image').toString('base64'));
        expect(imageParts[1].image_url).toContain(Buffer.from('second-image').toString('base64'));
    });

    test('logs a redacted provider payload summary for gpt-image-2 edit requests', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageBase64 = Buffer.from('first-image').toString('base64');
        const payloadSummaryLog = logger.info.mock.calls
            .map(([message]) => message)
            .find(message => message.startsWith('[Image Edits] Payload summary for model=gpt-image-2: '));

        expect(payloadSummaryLog).toBeDefined();
        expect(payloadSummaryLog).not.toContain(imageBase64);
        expect(payloadSummaryLog).not.toContain(requestBody.input[0].content[1].image_url);

        const loggedPayload = JSON.parse(payloadSummaryLog.replace('[Image Edits] Payload summary for model=gpt-image-2: ', ''));

        expect(loggedPayload.input[0].content[1].image_url).toEqual({
            kind: 'data-uri',
            media_type: 'image/png',
            base64_chars: imageBase64.length,
            bytes: Buffer.byteLength('first-image'),
            sha256: expect.stringMatching(/^[a-f0-9]{16}$/)
        });
    });

    test('preserves image tool options for gpt-image-2 edit requests', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'size', value: '1024x1024' },
            { name: 'quality', value: 'high' },
            { name: 'background', value: 'transparent' },
            { name: 'output_format', value: 'webp' },
            { name: 'input_fidelity', value: 'high' },
            { name: 'moderation', value: 'auto' },
            { name: 'output_compression', value: '80' },
            { name: 'partial_images', value: '2' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody._imageToolOptions).toEqual({
            size: '1024x1024',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            input_fidelity: 'high',
            moderation: 'auto',
            output_compression: 80,
            partial_images: 2
        });
    });
});

describe('/v1/images/generations request handling', () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        logger.info.mockClear();
        logger.warn.mockClear();
        logger.error.mockClear();
        logger.debug.mockClear();
        mockGenerateContent.mockResolvedValue({
            response: {
                output: [{
                    type: 'image_generation_call',
                    result: 'generated-image-b64',
                    output_format: 'png'
                }]
            }
        });
    });

    test('preserves requested image quality for gpt-image-2 generation requests', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '1024x1024',
            quality: 'medium',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody._imageQuality).toBe('medium');
    });

    test('preserves image tool options for gpt-image-2 generation requests', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '1024x1024',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            moderation: 'auto',
            output_compression: 80,
            partial_images: 2,
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody._imageToolOptions).toEqual({
            size: '1024x1024',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            moderation: 'auto',
            output_compression: 80,
            partial_images: 2
        });
    });

    test('uses configured request body limit for large image generation requests', async () => {
        const largePrompt = 'x'.repeat(10 * 1024 * 1024);
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: largePrompt,
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', REQUEST_BODY_MAX_BYTES: 12 * 1024 * 1024 },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.input[0].content[0].text).toBe(largePrompt);
    });
});
