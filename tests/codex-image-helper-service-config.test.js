import { initApiService, getApiService, getApiServiceWithFallback } from '../src/services/service-manager.js';
import { getServiceAdapter } from '../src/providers/adapter.js';
import requestContext from '../src/utils/context.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ config })),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

test.each([
    [undefined, 'gpt-6.1-sol', 'gpt-6.1-sol'],
    ['', 'gpt-6.1-sol', 'gpt-6.1-sol'],
    [null, 'gpt-6.1-sol', 'gpt-6.1-sol'],
    ['   ', 'gpt-6.1-sol', 'gpt-6.1-sol'],
    ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6.1-terra'],
    ['', '', 'gpt-6-luna']
])('startup and both request entrypoints resolve node %p with global %p', async (nodeValue, globalValue, expected) => {
    const config = {
        MODEL_PROVIDER: 'openai-codex-oauth',
        CODEX_IMAGE_HELPER_MODEL: globalValue,
        providerPools: {
            'openai-codex-oauth': [{ uuid: 'helper-node', isHealthy: true, lastKnownCodexPlan: 'pro', CODEX_IMAGE_HELPER_MODEL: nodeValue }]
        }
    };
    getServiceAdapter.mockClear();
    await initApiService(config, false, { persistenceEnabled: false });
    expect(getServiceAdapter.mock.calls[0][0].CODEX_IMAGE_HELPER_MODEL).toBe(expected);
    await requestContext.run({}, async () => {
        const service = await getApiService({ ...config }, 'gpt-image-2');
        expect(service.config.CODEX_IMAGE_HELPER_MODEL).toBe(expected);
        const result = await getApiServiceWithFallback({ ...config }, 'gpt-image-2');
        expect(result.serviceConfig.CODEX_IMAGE_HELPER_MODEL).toBe(expected);
        expect(result.service.config.CODEX_IMAGE_HELPER_MODEL).toBe(expected);
    });
    expect(config.CODEX_IMAGE_HELPER_MODEL).toBe(globalValue);
});
