import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ providerUuid: config.uuid })),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import {
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';
import { codexOverloadFailoverStore } from '../src/providers/openai/codex-overload-failover.js';

const providerType = 'openai-codex-oauth';
const failoverKey = 'session:service-routing-test';

function createConfig(providerUuids) {
    return {
        MODEL_PROVIDER: providerType,
        PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
        _codexOverloadFailoverKey: failoverKey,
        providerPools: {
            [providerType]: providerUuids.map(uuid => ({
                uuid,
                customName: uuid,
                codexAccountKey: `account-${uuid}`,
                lastKnownCodexPlan: 'pro',
                supportedModels: ['gpt-5.4-mini']
            }))
        }
    };
}

beforeEach(() => {
    codexOverloadFailoverStore.clear(failoverKey);
});

afterEach(() => {
    codexOverloadFailoverStore.clear(failoverKey);
    const manager = getProviderPoolManager();
    if (manager?.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
    }
    manager?.pendingSaves?.clear();
});

describe('Codex overload service routing', () => {
    test('selects another healthy credential on the next request and pins it', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        await initApiService(config);
        codexOverloadFailoverStore.recordFailure(failoverKey, 'codex-a');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-b');
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBeNull();
        expect(codexOverloadFailoverStore.getPinnedProvider(failoverKey)).toBe('codex-b');
        getProviderPoolManager().releaseSlot(providerType, result.uuid);

        const pinnedResult = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });
        expect(pinnedResult.uuid).toBe('codex-b');
        getProviderPoolManager().releaseSlot(providerType, pinnedResult.uuid);
    });

    test('allows the original credential when it is the only available credential', async () => {
        const config = createConfig(['codex-a']);
        await initApiService(config);
        codexOverloadFailoverStore.recordFailure(failoverKey, 'codex-a');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-a');
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBeNull();
        expect(codexOverloadFailoverStore.getPinnedProvider(failoverKey)).toBeNull();
        getProviderPoolManager().releaseSlot(providerType, result.uuid);
    });

    test('falls back to the original credential when alternatives are temporarily unavailable', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        await initApiService(config);
        const manager = getProviderPoolManager();
        manager.providerStatus[providerType].find(provider => provider.uuid === 'codex-b').config.isHealthy = false;
        codexOverloadFailoverStore.recordFailure(failoverKey, 'codex-a');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-a');
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBeNull();
        manager.releaseSlot(providerType, result.uuid);
    });
});
