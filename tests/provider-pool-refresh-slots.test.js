import { describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

function createManager(globalConfig = {}) {
    return new ProviderPoolManager({}, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            REFRESH_CONCURRENCY_GLOBAL: 1,
            REFRESH_CONCURRENCY_PER_PROVIDER: 1,
            REFRESH_TASK_TIMEOUT_MS: 0,
            ...globalConfig
        }
    });
}

function credential(uuid) {
    return {
        uuid,
        config: { uuid, isDisabled: false }
    };
}

async function drainMicrotasks() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

describe('ProviderPoolManager refresh queue slots', () => {
    test('releases the global slot after queued tasks for one provider finish', async () => {
        const manager = createManager();
        manager._refreshNodeToken = jest.fn(async () => {});

        manager._enqueueRefreshImmediate('claude-kiro-oauth', credential('first'), true);
        manager._enqueueRefreshImmediate('claude-kiro-oauth', credential('second'), true);

        await drainMicrotasks();

        expect(manager._refreshNodeToken).toHaveBeenCalledTimes(2);
        expect(manager.activeProviderRefreshes).toBe(0);
        expect(manager.refreshingUuids.size).toBe(0);
        expect(manager.refreshQueues['claude-kiro-oauth']).toBeUndefined();
        clearTimeout(manager.saveTimer);
    });

    test('registers one global waiter for queued tasks from the same provider', async () => {
        const manager = createManager();
        let releaseFirstProvider;
        const firstProviderBarrier = new Promise(resolve => {
            releaseFirstProvider = resolve;
        });
        const calls = [];
        manager._refreshNodeToken = jest.fn(async (providerType, providerStatus) => {
            calls.push(`${providerType}:${providerStatus.uuid}`);
            if (providerType === 'provider-a') {
                await firstProviderBarrier;
            }
        });

        manager._enqueueRefreshImmediate('provider-a', credential('a1'), true);
        manager._enqueueRefreshImmediate('provider-b', credential('b1'), true);
        manager._enqueueRefreshImmediate('provider-b', credential('b2'), true);

        await new Promise(resolve => setImmediate(resolve));

        expect(manager.globalRefreshWaiters).toHaveLength(1);

        releaseFirstProvider();
        await drainMicrotasks();
        await drainMicrotasks();

        expect(calls).toEqual(['provider-a:a1', 'provider-b:b1', 'provider-b:b2']);
        expect(manager.activeProviderRefreshes).toBe(0);
        expect(manager.globalRefreshWaiters).toHaveLength(0);
        expect(manager.refreshingUuids.size).toBe(0);
        expect(manager.refreshQueues).toEqual({});
        clearTimeout(manager.saveTimer);
    });

    test('releases the provider slot after the last concurrent task finishes', async () => {
        const manager = createManager({ REFRESH_CONCURRENCY_PER_PROVIDER: 2 });
        const releases = new Map();
        manager._refreshNodeToken = jest.fn((_providerType, providerStatus) => {
            return new Promise(resolve => releases.set(providerStatus.uuid, resolve));
        });

        manager._enqueueRefreshImmediate('provider-a', credential('first'), true);
        manager._enqueueRefreshImmediate('provider-a', credential('second'), true);
        await new Promise(resolve => setImmediate(resolve));

        expect(manager.activeProviderRefreshes).toBe(1);
        expect(manager.refreshQueues['provider-a'].activeCount).toBe(2);

        releases.get('first')();
        await drainMicrotasks();

        expect(manager.activeProviderRefreshes).toBe(1);
        expect(manager.refreshQueues['provider-a'].activeCount).toBe(1);

        releases.get('second')();
        await drainMicrotasks();

        expect(manager.activeProviderRefreshes).toBe(0);
        expect(manager.refreshQueues).toEqual({});
        clearTimeout(manager.saveTimer);
    });

    test('shutdown drops a waiting provider without leaking its queued credentials', async () => {
        const manager = createManager();
        let releaseActive;
        const activeBarrier = new Promise(resolve => {
            releaseActive = resolve;
        });
        const calls = [];
        manager._refreshNodeToken = jest.fn(async (providerType, providerStatus) => {
            calls.push(`${providerType}:${providerStatus.uuid}`);
            if (providerType === 'provider-a') {
                await activeBarrier;
            }
        });

        manager._enqueueRefreshImmediate('provider-a', credential('a1'), true);
        manager._enqueueRefreshImmediate('provider-b', credential('b1'), true);
        manager._enqueueRefreshImmediate('provider-b', credential('b2'), true);
        await new Promise(resolve => setImmediate(resolve));

        expect(manager.globalRefreshWaiters).toHaveLength(1);
        expect(manager.refreshQueues['provider-b'].waitingForGlobalSlot).toBe(true);
        expect(manager.refreshQueues['provider-b'].waitingTasks).toHaveLength(1);

        const shutdownPromise = manager.shutdownRefreshQueue();
        releaseActive();
        await shutdownPromise;

        expect(calls).toEqual(['provider-a:a1']);
        expect(manager.activeProviderRefreshes).toBe(0);
        expect(manager.globalRefreshWaiters).toHaveLength(0);
        expect(manager.refreshingUuids.size).toBe(0);
        expect(manager.refreshQueues).toEqual({});
        clearTimeout(manager.saveTimer);
    });
});
