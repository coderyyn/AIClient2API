import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn(() => ({}))
}));

jest.mock('../src/services/usage-service.js', () => ({
    usageService: {
        getFormattedUsage: jest.fn(),
        formatUsage: jest.fn(value => value)
    }
}));

import { usageService } from '../src/services/usage-service.js';
import { getAllProvidersUsage } from '../src/ui-modules/usage-api.js';

const PROVIDER_TYPE = 'gemini-antigravity';

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('usage refresh account isolation', () => {
    test('a timed out account does not prevent later accounts from refreshing', async () => {
        usageService.getFormattedUsage.mockImplementation((_providerType, uuid) => {
            if (uuid === 'slow') return new Promise(() => {});
            return Promise.resolve({ summary: { plan: 'Ultra' }, items: [] });
        });
        const config = {
            USAGE_REFRESH_ACCOUNT_TIMEOUT_MS: 100,
            providerPools: {
                [PROVIDER_TYPE]: [
                    { uuid: 'slow', isHealthy: true },
                    { uuid: 'fast', isHealthy: true }
                ]
            }
        };

        const refreshPromise = getAllProvidersUsage(config, null);
        await jest.advanceTimersByTimeAsync(100);
        const result = await refreshPromise;
        const instances = result.providers[PROVIDER_TYPE].instances;

        expect(instances.find(instance => instance.uuid === 'slow').error).toContain('timed out');
        expect(instances.find(instance => instance.uuid === 'fast')).toMatchObject({ success: true });
    });

    test('limits concurrent account usage requests per provider', async () => {
        let active = 0;
        let maxActive = 0;
        const releases = new Map();
        const started = [];
        usageService.getFormattedUsage.mockImplementation((_providerType, uuid) => new Promise(resolve => {
            active++;
            maxActive = Math.max(maxActive, active);
            started.push(uuid);
            releases.set(uuid, () => {
                active--;
                resolve({ summary: {}, items: [] });
            });
        }));
        const config = {
            USAGE_REFRESH_ACCOUNT_TIMEOUT_MS: 1_000,
            USAGE_REFRESH_CONCURRENCY_PER_PROVIDER: 2,
            providerPools: {
                [PROVIDER_TYPE]: [
                    { uuid: 'a', isHealthy: true },
                    { uuid: 'b', isHealthy: true },
                    { uuid: 'c', isHealthy: true }
                ]
            }
        };

        const refreshPromise = getAllProvidersUsage(config, null);
        await Promise.resolve();
        await Promise.resolve();
        expect(maxActive).toBe(2);
        expect(started).toEqual(['a', 'b']);

        releases.get('a')();
        await jest.advanceTimersByTimeAsync(0);
        expect(maxActive).toBe(2);
        expect(started).toEqual(['a', 'b', 'c']);
        releases.get('b')();
        releases.get('c')();
        await refreshPromise;
    });
});
