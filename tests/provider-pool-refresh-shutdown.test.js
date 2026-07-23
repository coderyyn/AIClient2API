import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { getServiceAdapter } from '../src/providers/adapter.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth', 'openai-qwen-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

function createManager(providerPools, globalConfig = {}) {
    return new ProviderPoolManager(providerPools, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            REFRESH_BUFFER_DELAY: 100,
            REFRESH_CONCURRENCY_GLOBAL: 1,
            REFRESH_CONCURRENCY_PER_PROVIDER: 1,
            REFRESH_TASK_TIMEOUT_MS: 0,
            ...globalConfig
        }
    });
}

function provider(manager, type, uuid) {
    return manager.providerStatus[type].find(item => item.uuid === uuid);
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('ProviderPoolManager refresh queue shutdown', () => {
    test('cancels buffered refreshes before their timer fires and rejects later enqueue attempts', async () => {
        const type = 'openai-codex-oauth';
        const configs = Array.from({ length: 5 }, (_, index) => ({
            uuid: `codex-${index}`,
            customName: `Codex ${index}`,
            isHealthy: true
        }));
        const manager = createManager({ [type]: configs });
        const refresh = jest.spyOn(manager, '_refreshNodeToken').mockResolvedValue(true);

        manager._enqueueRefresh(type, provider(manager, type, 'codex-0'));
        expect(Object.keys(manager.refreshBufferTimers)).toEqual([type]);

        const firstShutdown = manager.shutdownRefreshQueue();
        const secondShutdown = manager.shutdownRefreshQueue();
        expect(secondShutdown).toBe(firstShutdown);
        await firstShutdown;
        await jest.advanceTimersByTimeAsync(100);

        manager._enqueueRefresh(type, provider(manager, type, 'codex-1'), true);
        await Promise.resolve();

        expect(refresh).not.toHaveBeenCalled();
        expect(manager.refreshBufferTimers).toEqual({});
        expect(manager.refreshBufferQueues).toEqual({});
        clearTimeout(manager.saveTimer);
    });

    test('drops unstarted waiting refreshes but waits for an active refresh to settle', async () => {
        const type = 'openai-codex-oauth';
        const manager = createManager({
            [type]: [
                { uuid: 'active', customName: 'Active', isHealthy: true },
                { uuid: 'waiting', customName: 'Waiting', isHealthy: true }
            ]
        });
        let releaseActive;
        const activeBarrier = new Promise(resolve => {
            releaseActive = resolve;
        });
        const refresh = jest.spyOn(manager, '_refreshNodeToken').mockImplementation((_type, status) => {
            return status.uuid === 'active' ? activeBarrier : Promise.resolve(true);
        });

        manager._enqueueRefresh(type, provider(manager, type, 'active'), true);
        manager._enqueueRefresh(type, provider(manager, type, 'waiting'), true);
        await Promise.resolve();

        let drained = false;
        const shutdownPromise = manager.shutdownRefreshQueue().then(() => {
            drained = true;
        });
        await Promise.resolve();

        expect(drained).toBe(false);
        expect(manager.refreshingUuids.has('waiting')).toBe(false);
        expect(refresh.mock.calls.map(([, status]) => status.uuid)).toEqual(['active']);

        releaseActive(true);
        await shutdownPromise;
        expect(drained).toBe(true);
        expect(manager.refreshingUuids.size).toBe(0);
        clearTimeout(manager.saveTimer);
    });

    test('keeps shutdown pending after the wrapper times out until the adapter operation settles', async () => {
        const type = 'openai-codex-oauth';
        const manager = createManager({
            [type]: [{ uuid: 'slow', customName: 'Slow', isHealthy: true }]
        }, { REFRESH_TASK_TIMEOUT_MS: 10 });
        let releaseOperation;
        const adapterOperation = new Promise(resolve => {
            releaseOperation = resolve;
        });
        getServiceAdapter.mockReturnValue({
            refreshToken: jest.fn(() => adapterOperation)
        });

        manager._enqueueRefresh(type, provider(manager, type, 'slow'));
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(10);
        await Promise.resolve();

        let drained = false;
        const shutdownPromise = manager.shutdownRefreshQueue().then(() => {
            drained = true;
        });
        await Promise.resolve();

        expect(drained).toBe(false);

        releaseOperation(true);
        await shutdownPromise;
        expect(drained).toBe(true);
        clearTimeout(manager.saveTimer);
    });
});
