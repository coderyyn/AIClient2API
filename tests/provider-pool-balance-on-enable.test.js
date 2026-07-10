import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let consoleSpies = [];

function createPoolManager(providers) {
    return new ProviderPoolManager({
        'openai-codex-oauth': providers
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
        }
    });
}

function getProvider(manager, uuid) {
    return manager.providerStatus['openai-codex-oauth'].find(provider => provider.uuid === uuid);
}

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('provider pool balance on enable', () => {
    test('syncs usageCount and recent load to sibling median instead of keeping stale low counters', () => {
        const manager = createPoolManager([
            { uuid: 'paused', customName: 'Paused', providerWeight: 1, usageCount: 50, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'active-a', customName: 'ActiveA', providerWeight: 1, usageCount: 800, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'active-b', customName: 'ActiveB', providerWeight: 1, usageCount: 1000, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] }
        ]);
        clearTimeout(manager.saveTimer);

        manager.disableProvider('openai-codex-oauth', { uuid: 'paused' });
        manager._seedProviderSelectionLoad('openai-codex-oauth', getProvider(manager, 'active-a'), 40);
        manager._seedProviderSelectionLoad('openai-codex-oauth', getProvider(manager, 'active-b'), 60);

        manager.enableProvider('openai-codex-oauth', { uuid: 'paused' });

        const paused = getProvider(manager, 'paused');
        expect(paused.config.usageCount).toBe(50);
        expect(manager._getProviderSelectionLoad('openai-codex-oauth', paused, 60 * 60 * 1000)).toBe(50);
    });

    test('prefers recent 60m load over stale lifetime usageCount when balancing equal weights', async () => {
        const manager = createPoolManager([
            { uuid: 'stale-high', customName: 'StaleHigh', providerWeight: 1, usageCount: 5000, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'recent-low', customName: 'RecentLow', providerWeight: 1, usageCount: 100, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] }
        ]);
        clearTimeout(manager.saveTimer);

        manager._seedProviderSelectionLoad('openai-codex-oauth', getProvider(manager, 'stale-high'), 80);
        manager._seedProviderSelectionLoad('openai-codex-oauth', getProvider(manager, 'recent-low'), 10);

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');
        expect(selected.uuid).toBe('recent-low');
    });
});
