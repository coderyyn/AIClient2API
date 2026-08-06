import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { isImageGenerationRequest } from '../src/utils/common.js';
import { withStickyProviderAffinity } from '../src/services/service-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth', 'openaiResponses-custom']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let consoleSpies = [];

function createImagePoolManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': [
            {
                uuid: 'codex-c',
                customName: 'Codex C',
                providerWeight: 9,
                lastKnownCodexPlan: 'pro',
                supportedModels: ['gpt-image-2']
            },
            {
                uuid: 'codex-a',
                customName: 'Codex A',
                providerWeight: 1,
                lastKnownCodexPlan: 'pro',
                supportedModels: ['gpt-image-2']
            },
            {
                uuid: 'codex-b',
                customName: 'Codex B',
                providerWeight: 3,
                lastKnownCodexPlan: 'pro',
                supportedModels: ['gpt-image-2']
            }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
        }
    });
}

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) =>
        jest.spyOn(console, method).mockImplementation(() => {})
    );
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('image generation request detection', () => {
    test('recognizes dedicated Images endpoints', () => {
        expect(isImageGenerationRequest({ requestPath: '/v1/images/generations' })).toBe(true);
        expect(isImageGenerationRequest({ requestPath: '/v1/images/edits' })).toBe(true);
    });

    test('recognizes image models after provider-prefix and fast-alias normalization', () => {
        expect(isImageGenerationRequest({ model: 'openai-codex-oauth:gpt-image-2-fast' })).toBe(true);
        expect(isImageGenerationRequest({ model: 'gemini-antigravity:gemini-3.1-flash-image' })).toBe(true);
    });

    test('recognizes explicit OpenAI and Gemini image output signals', () => {
        expect(isImageGenerationRequest({
            body: { tools: [{ type: 'image_generation' }] }
        })).toBe(true);
        expect(isImageGenerationRequest({
            body: { generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }
        })).toBe(true);
        expect(isImageGenerationRequest({
            body: { generation_config: { image_config: { aspect_ratio: '1:1' } } }
        })).toBe(true);
    });

    test('does not treat image input alone as image generation', () => {
        expect(isImageGenerationRequest({
            model: 'gpt-5.5',
            body: {
                input: [{
                    role: 'user',
                    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]
                }]
            }
        })).toBe(false);
    });
});

describe('image provider round robin', () => {
    test('prevents Codex sticky affinity from being injected for image routing', () => {
        const options = withStickyProviderAffinity({
            CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
            potluckApiKey: 'shared-key'
        }, 'openai-codex-oauth', {
            requestedModel: 'gpt-image-2',
            routingStrategy: 'image-round-robin',
            preferredProviderUuid: 'codex-a'
        });

        expect(options.routingStrategy).toBe('image-round-robin');
        expect(options).not.toHaveProperty('stickyProviderKey');
        expect(options).not.toHaveProperty('preferredProviderUuid');
    });

    test('rotates equally across eligible providers and ignores sticky affinity and weights', async () => {
        const manager = createImagePoolManager();
        const selected = [];

        for (let index = 0; index < 6; index++) {
            const provider = await manager.selectProvider('openai-codex-oauth', 'gpt-image-2', {
                routingStrategy: 'image-round-robin',
                stickyProviderKey: 'same-potluck-key',
                skipUsageCount: true
            });
            selected.push(provider.uuid);
        }

        clearTimeout(manager.saveTimer);
        expect(selected).toEqual([
            'codex-a', 'codex-b', 'codex-c',
            'codex-a', 'codex-b', 'codex-c'
        ]);
    });

    test('shares one image cursor between a base model and its fast alias', async () => {
        const manager = createImagePoolManager();
        manager.providerStatus['openai-codex-oauth'].forEach(provider => {
            provider.config.supportedModels = ['gpt-image-2', 'gpt-image-2-fast'];
        });

        const base = await manager.selectProvider('openai-codex-oauth', 'gpt-image-2', {
            routingStrategy: 'image-round-robin',
            skipUsageCount: true
        });
        const fast = await manager.selectProvider('openai-codex-oauth', 'gpt-image-2-fast', {
            routingStrategy: 'image-round-robin',
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect([base.uuid, fast.uuid]).toEqual(['codex-a', 'codex-b']);
    });

    test('skips excluded providers and lets them rejoin later selections', async () => {
        const manager = createImagePoolManager();

        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-image-2', {
            routingStrategy: 'image-round-robin',
            excludeProviderUuids: ['codex-b'],
            skipUsageCount: true
        });
        const second = await manager.selectProvider('openai-codex-oauth', 'gpt-image-2', {
            routingStrategy: 'image-round-robin',
            excludeProviderUuids: ['codex-b'],
            skipUsageCount: true
        });
        const third = await manager.selectProvider('openai-codex-oauth', 'gpt-image-2', {
            routingStrategy: 'image-round-robin',
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect([first.uuid, second.uuid, third.uuid]).toEqual(['codex-a', 'codex-c', 'codex-c']);
    });

    test('stays inside the entry provider type even when a mixed provider pool exists', async () => {
        const manager = new ProviderPoolManager({
            'openai-codex-oauth': [
                { uuid: 'codex-a', lastKnownCodexPlan: 'pro', supportedModels: ['gpt-image-2'] },
                { uuid: 'codex-b', lastKnownCodexPlan: 'pro', supportedModels: ['gpt-image-2'] }
            ],
            'openaiResponses-custom': [
                { uuid: 'edge-a', providerWeight: 10, supportedModels: ['gpt-image-2'] }
            ]
        }, {
            logLevel: 'error',
            saveDebounceTime: 60 * 60 * 1000,
            globalConfig: {
                PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
                mixedProviderPools: {
                    images: {
                        enabled: true,
                        matchModels: ['gpt-image-*'],
                        entryProviders: ['openai-codex-oauth'],
                        candidateProviders: ['openai-codex-oauth', 'openaiResponses-custom']
                    }
                }
            }
        });

        const selectedTypes = [];
        for (let index = 0; index < 4; index++) {
            const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-image-2', {
                routingStrategy: 'image-round-robin',
                skipUsageCount: true
            });
            selectedTypes.push(selected.actualProviderType);
        }

        clearTimeout(manager.saveTimer);
        expect(selectedTypes).toEqual([
            'openai-codex-oauth',
            'openai-codex-oauth',
            'openai-codex-oauth',
            'openai-codex-oauth'
        ]);
    });
});
