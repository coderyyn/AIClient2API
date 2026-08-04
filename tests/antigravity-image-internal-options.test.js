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
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

describe('Antigravity image payloads', () => {
    test('does not send gateway-only image options to the Google upstream payload', () => {
        const service = new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });
        service.availableModels = ['gemini-3.1-flash-image'];

        const { payload } = service.buildAntigravityPayload('gemini-3.1-flash-image', {
            model: 'gemini-3.1-flash-image',
            contents: [{ role: 'user', parts: [{ text: 'draw a yellow banana on a blue table' }] }],
            _imageSize: '1024x1024',
            _imageQuality: 'high',
            _imageToolOptions: { background: 'transparent', output_format: 'png' }
        });

        expect(payload.request).not.toHaveProperty('_imageSize');
        expect(payload.request).not.toHaveProperty('_imageQuality');
        expect(payload.request).not.toHaveProperty('_imageToolOptions');
        expect(payload.request.contents[0].parts[0].text).toContain('yellow banana');
        expect(payload.request.generationConfig.imageConfig).toMatchObject({
            imageSize: '1K',
            aspectRatio: '1:1'
        });
    });
});
