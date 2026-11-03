import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { normalizeCodexImageHelperModel, resolveCodexImageHelperModel } from '../src/providers/openai/codex-image-helper.js';
import { getProviderModels } from '../src/providers/provider-models.js';
import { CONFIG } from '../src/core/config-manager.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: () => null }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: config => config,
    isTLSSidecarEnabledForProvider: () => false,
    getProxyConfigForProvider: () => null
}));

const services = [];
afterEach(() => services.splice(0).forEach(service => service.stopCacheCleanup()));

function service(config = {}) {
    const instance = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', ...config });
    services.push(instance);
    return instance;
}

function request() {
    return { input: [{ role: 'user', content: 'Draw a circle.' }] };
}

test.each([undefined, null, '', '   '])('empty node value %p inherits global, then default', value => {
    expect(resolveCodexImageHelperModel({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' }, { CODEX_IMAGE_HELPER_MODEL: value }))
        .toBe('gpt-6.1-sol');
    expect(resolveCodexImageHelperModel({ CODEX_IMAGE_HELPER_MODEL: value })).toBe('gpt-6-luna');
});

test('node takes precedence and is normalized without consulting an invalid global setting', () => {
    const setting = resolveCodexImageHelperModel({ CODEX_IMAGE_HELPER_MODEL: 123 }, { CODEX_IMAGE_HELPER_MODEL: ' gpt-6.1-terra ' });
    expect(normalizeCodexImageHelperModel(setting)).toBe('gpt-6.1-terra');
});

test.each(getProviderModels('openai-codex-oauth').filter(model => !model.startsWith('gpt-image-')))(
    'accepts catalog text base model %s', model => {
        expect(normalizeCodexImageHelperModel(` ${model} `)).toBe(model);
    }
);

test.each([123, true, {}, [], 'unknown', 'gpt-image-2', 'gpt-image-custom', 'gpt-6.1-sol-fast', 'gpt-6-astra-ultrafast'])(
    'rejects invalid helper %p as a configuration error', value => {
        expect(() => normalizeCodexImageHelperModel(value)).toThrow('CODEX_IMAGE_HELPER_MODEL');
        try {
            normalizeCodexImageHelperModel(value);
        } catch (error) {
            expect(error).toMatchObject({ status: 400, code: 'invalid_image_helper_model', skipErrorCount: true, shouldSwitchCredential: false });
        }
    }
);

test.each([
    ['gpt-image-2', 'gpt-image-2', undefined],
    ['gpt-image-2-fast', 'gpt-image-2', 'priority'],
    ['gpt-image-2.5', 'gpt-image-2.5-flare', undefined],
    ['gpt-image-2.5-flare-fast', 'gpt-image-2.5-flare', 'priority'],
    ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst', undefined]
])('constructs %s with explicit helper and image tool model', async (model, toolModel, tier) => {
    const instance = service({
        CODEX_IMAGE_HELPER_MODEL: ' gpt-6.1-terra ',
        codexModelRemap: { 'gpt-6.1-terra': 'gpt-5.6-terra' },
        codexGpt6OverrideEnabled: true,
        codexGpt6OverrideModel: 'gpt-6-sol'
    });
    for (const stream of [false, true]) {
        const body = await instance.prepareRequestBody(model, {
            ...request(), _imageToolOptions: { size: '1024x1024', quality: 'high', background: 'transparent', output_format: 'webp' }
        }, stream);
        expect(body.model).toBe('gpt-6.1-terra');
        expect(body.stream).toBe(stream);
        expect(body.service_tier).toBe(tier);
        expect(body.tools).toEqual([{
            type: 'image_generation', model: toolModel, size: '1024x1024', quality: 'high', background: 'transparent', output_format: 'webp'
        }]);
        expect(body._imageToolOptions).toBeUndefined();
    }
});

test('validates manual settings only for image requests', async () => {
    const instance = service({ CODEX_IMAGE_HELPER_MODEL: 'gpt-image-2' });
    await expect(instance.prepareRequestBody('gpt-image-2', request(), false)).rejects.toMatchObject({ skipErrorCount: true });
    expect((await instance.prepareRequestBody('gpt-6-sol', request(), false)).model).toBe('gpt-6-sol');
});

test('adapter built from a plain spread with an empty node value inherits the live global setting', async () => {
    const previous = CONFIG.CODEX_IMAGE_HELPER_MODEL;
    try {
        CONFIG.CODEX_IMAGE_HELPER_MODEL = 'gpt-6.1-sol';
        // Mirrors usage-api/prewarm/pool-manager: { ...CONFIG, ...provider } lets '' override the global value.
        const instance = service({ ...CONFIG, CODEX_IMAGE_HELPER_MODEL: '' });
        expect((await instance.prepareRequestBody('gpt-image-2', request(), false)).model).toBe('gpt-6.1-sol');
        CONFIG.CODEX_IMAGE_HELPER_MODEL = 'gpt-6-sol';
        expect((await instance.prepareRequestBody('gpt-image-2', request(), false)).model).toBe('gpt-6-sol');
        const override = service({ ...CONFIG, CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-terra' });
        expect((await override.prepareRequestBody('gpt-image-2', request(), false)).model).toBe('gpt-6.1-terra');
    } finally {
        CONFIG.CODEX_IMAGE_HELPER_MODEL = previous;
    }
});

test('existing in-flight body retains its helper after configuration changes', async () => {
    const instance = service({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' });
    const first = await instance.prepareRequestBody('gpt-image-2', request(), false);
    instance.config.CODEX_IMAGE_HELPER_MODEL = 'gpt-6-luna';
    const second = await instance.prepareRequestBody('gpt-image-2', request(), false);
    expect(first.model).toBe('gpt-6.1-sol');
    expect(second.model).toBe('gpt-6-luna');
});
