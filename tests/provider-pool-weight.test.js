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

function createWeightedPoolManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': [
            { uuid: 'low-weight', customName: 'Low', providerWeight: 1, supportedModels: ['gpt-5.5'] },
            { uuid: 'high-weight', customName: 'High', providerWeight: 3, supportedModels: ['gpt-5.5'] }
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
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('provider pool weight', () => {
    test('selects high weight providers more often than low weight providers', async () => {
        const manager = createWeightedPoolManager();
        const counts = { 'high-weight': 0, 'low-weight': 0 };

        for (let i = 0; i < 8; i++) {
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');
            counts[selected.uuid] += 1;
        }

        clearTimeout(manager.saveTimer);
        expect(counts['high-weight']).toBeGreaterThan(counts['low-weight']);
    });
});
