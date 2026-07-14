import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth', 'openaiResponses-custom']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let consoleSpies = [];
let managers = [];

function createMixedGptPoolManager(overrides = {}) {
    const manager = new ProviderPoolManager({
        'openai-codex-oauth': [
            {
                uuid: 'codex-local',
                customName: 'Codex Local',
                providerWeight: 2,
                lastKnownCodexPlan: 'pro',
                supportedModels: ['gpt-5.5'],
                ...overrides.codex
            }
        ],
        'openaiResponses-custom': [
            {
                uuid: 'edge-remote',
                customName: 'Edge Remote',
                providerWeight: 2,
                supportedModels: ['gpt-5.5'],
                ...overrides.edge
            }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            mixedProviderPools: {
                gpt: {
                    enabled: true,
                    matchModels: ['gpt-*'],
                    entryProviders: ['openai-codex-oauth'],
                    candidateProviders: ['openai-codex-oauth', 'openaiResponses-custom']
                }
            }
        }
    });
    managers.push(manager);
    return manager;
}

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    for (const manager of managers) {
        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
        }
    }
    managers = [];
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('mixed GPT provider pool', () => {
    test('flattens GPT candidate provider types and balances by provider weight', async () => {
        const manager = createMixedGptPoolManager();
        const counts = { 'openai-codex-oauth': 0, 'openaiResponses-custom': 0 };

        for (let i = 0; i < 4; i++) {
            const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.5');
            counts[selected.actualProviderType] += 1;
        }

        expect(counts).toEqual({
            'openai-codex-oauth': 2,
            'openaiResponses-custom': 2
        });
    });

    test('uses another mixed candidate when a weighted provider is at concurrency capacity', async () => {
        const manager = createMixedGptPoolManager({
            codex: { concurrencyLimit: 1, queueLimit: 0 },
            edge: { concurrencyLimit: 1, queueLimit: 0 }
        });
        manager.providerStatus['openai-codex-oauth'][0].state.activeCount = 1;

        const selected = await manager.acquireSlotWithFallback('openai-codex-oauth', 'gpt-5.5');

        expect(selected.actualProviderType).toBe('openaiResponses-custom');
        expect(selected.config.uuid).toBe('edge-remote');
    });

    test('can exclude a failed provider type during mixed pool retry selection', async () => {
        const manager = createMixedGptPoolManager();

        const selected = await manager.acquireSlotWithFallback('openai-codex-oauth', 'gpt-5.5', {
            excludeProviderTypes: ['openai-codex-oauth']
        });

        expect(selected.actualProviderType).toBe('openaiResponses-custom');
        expect(selected.config.uuid).toBe('edge-remote');
    });

    test('deprioritizes a failed provider type when another mixed candidate is available', async () => {
        const manager = createMixedGptPoolManager();

        const selected = await manager.acquireSlotWithFallback('openai-codex-oauth', 'gpt-5.5', {
            deprioritizeProviderTypes: ['openai-codex-oauth']
        });

        expect(selected.actualProviderType).toBe('openaiResponses-custom');
        expect(selected.config.uuid).toBe('edge-remote');
    });

    test('falls back to a deprioritized provider type when it is the only available candidate', async () => {
        const manager = createMixedGptPoolManager({
            edge: { isHealthy: false }
        });

        const selected = await manager.acquireSlotWithFallback('openai-codex-oauth', 'gpt-5.5', {
            deprioritizeProviderTypes: ['openai-codex-oauth']
        });

        expect(selected.actualProviderType).toBe('openai-codex-oauth');
        expect(selected.config.uuid).toBe('codex-local');
    });

    test('does not mix providers for non-matching models', async () => {
        const manager = createMixedGptPoolManager({
            codex: { supportedModels: ['claude-test'] },
            edge: { supportedModels: ['claude-test'] }
        });

        const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'claude-test');

        expect(selected.actualProviderType).toBe('openai-codex-oauth');
        expect(selected.config.uuid).toBe('codex-local');
    });

    test('distributes sticky mixed GPT affinity keys by provider weight', async () => {
        const manager = createMixedGptPoolManager({
            codex: { providerWeight: 1 },
            edge: { providerWeight: 3 }
        });
        const firstSelections = new Map();
        const counts = { 'openai-codex-oauth': 0, 'openaiResponses-custom': 0 };

        for (let i = 0; i < 200; i++) {
            const stickyProviderKey = `mixed-cache-key-${i}`;
            const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                skipUsageCount: true
            });
            firstSelections.set(stickyProviderKey, selected.actualProviderType);
            counts[selected.actualProviderType] += 1;
        }

        for (const [stickyProviderKey, actualProviderType] of firstSelections.entries()) {
            const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                skipUsageCount: true
            });
            expect(selected.actualProviderType).toBe(actualProviderType);
        }

        expect(counts['openaiResponses-custom']).toBeGreaterThanOrEqual(counts['openai-codex-oauth'] * 2);
    });
});
