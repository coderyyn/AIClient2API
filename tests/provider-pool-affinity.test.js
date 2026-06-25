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

function createCodexPoolManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': [
            { uuid: 'codex-a', customName: 'Codex A', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-b', customName: 'Codex B', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-c', customName: 'Codex C', supportedModels: ['gpt-5.5'] }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
        }
    });
}

function createWeightedCodexPoolManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': [
            { uuid: 'codex-low', customName: 'Codex Low', providerWeight: 1, supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-high', customName: 'Codex High', providerWeight: 3, supportedModels: ['gpt-5.5'] }
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

describe('provider pool sticky affinity', () => {
    test('selects the same healthy Codex provider for the same affinity key', async () => {
        const manager = createCodexPoolManager();

        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        const selectedUuids = [];
        for (let i = 0; i < 5; i++) {
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey: 'potluck-key-alpha',
                skipUsageCount: true
            });
            selectedUuids.push(selected.uuid);
        }

        clearTimeout(manager.saveTimer);
        expect(new Set(selectedUuids)).toEqual(new Set([first.uuid]));
    });

    test('falls back to another healthy Codex provider when the affined provider is unavailable', async () => {
        const manager = createCodexPoolManager();
        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        first.isHealthy = false;

        const next = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect(next.uuid).not.toBe(first.uuid);
        expect(next.isHealthy).toBe(true);
    });

    test('excludes a failed provider during sticky retry selection', async () => {
        const manager = createCodexPoolManager();
        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        const retrySelection = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            excludeProviderUuids: [first.uuid],
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect(retrySelection.uuid).not.toBe(first.uuid);
        expect(retrySelection.isHealthy).toBe(true);
    });

    test('distributes different affinity keys by Codex provider weight while keeping each key sticky', async () => {
        const manager = createWeightedCodexPoolManager();
        const firstSelections = new Map();
        const counts = { 'codex-low': 0, 'codex-high': 0 };

        for (let i = 0; i < 200; i++) {
            const stickyProviderKey = `cache-key-${i}`;
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                skipUsageCount: true
            });
            firstSelections.set(stickyProviderKey, selected.uuid);
            counts[selected.uuid] += 1;
        }

        for (const [stickyProviderKey, uuid] of firstSelections.entries()) {
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                skipUsageCount: true
            });
            expect(selected.uuid).toBe(uuid);
        }

        clearTimeout(manager.saveTimer);
        expect(counts['codex-high']).toBeGreaterThanOrEqual(counts['codex-low'] * 2);
    });
});
