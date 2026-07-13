import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
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

let consoleSpies = [];

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('Codex image generation tool options', () => {
    test('maps internal image quality onto the image_generation tool', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2', {
                model: 'gpt-image-2',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }],
                _imageSize: '1024x1024',
                _imageQuality: 'medium'
            }, false);

            expect(body.tools).toEqual([{
                type: 'image_generation',
                size: '1024x1024',
                quality: 'medium'
            }]);
            expect(body._imageSize).toBeUndefined();
            expect(body._imageQuality).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('maps internal image tool options onto the image_generation tool', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2', {
                model: 'gpt-image-2',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }],
                _imageToolOptions: {
                    size: '1024x1024',
                    quality: 'high',
                    background: 'transparent',
                    output_format: 'webp',
                    moderation: 'auto',
                    output_compression: 80,
                    partial_images: 2
                }
            }, false);

            expect(body.tools).toEqual([{
                type: 'image_generation',
                size: '1024x1024',
                quality: 'high',
                background: 'transparent',
                output_format: 'webp',
                moderation: 'auto',
                output_compression: 80,
                partial_images: 2
            }]);
            expect(body._imageToolOptions).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test.each([
        { type: 'function', name: 'image_gen.imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'image_gen__imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } },
        { type: 'function', function: { name: 'image_gen.imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'image_gen__imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } } }
    ])('does not add hosted image_generation when an image generation function is already present', async (imageFunctionTool) => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                model: 'gpt-5.4',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
                tools: [imageFunctionTool]
            }, true);

            expect(body.tools).toContainEqual(imageFunctionTool);
            expect(body.tools.filter(tool => tool.type === 'image_generation')).toHaveLength(0);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('keeps default image_generation injection for unrelated functions', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                model: 'gpt-5.4',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
                tools: [{ type: 'function', name: 'lookup_weather', parameters: { type: 'object', properties: {} } }]
            }, true);

            expect(body.tools.filter(tool => tool.type === 'image_generation')).toHaveLength(1);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not duplicate an existing hosted image_generation tool', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                model: 'gpt-5.4',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
                tools: [{ type: 'image_generation', output_format: 'webp' }]
            }, true);

            expect(body.tools.filter(tool => tool.type === 'image_generation')).toEqual([
                { type: 'image_generation', output_format: 'webp' }
            ]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not inject hosted image_generation for Spark models', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.3-codex-spark', {
                model: 'gpt-5.3-codex-spark',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
            }, true);

            expect(body.tools.filter(tool => tool.type === 'image_generation')).toHaveLength(0);
        } finally {
            service.stopCacheCleanup();
        }
    });
});
