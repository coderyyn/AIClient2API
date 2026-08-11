import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    UsageCacheAutoRefreshService,
    startUsageCacheAutoRefreshService
} from '../src/services/usage-cache-auto-refresh-service.js';

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('usage cache auto refresh service shutdown', () => {
    test('concurrent refresh callers reuse the active refresh result', async () => {
        let releaseUsage;
        const usageBarrier = new Promise(resolve => {
            releaseUsage = resolve;
        });
        const fetchUsage = jest.fn(() => usageBarrier);
        const service = new UsageCacheAutoRefreshService({
            config: {},
            providerPoolManager: {},
            fetchUsage,
            persistUsage: jest.fn().mockResolvedValue()
        });

        const firstRefresh = service.refresh();
        await Promise.resolve();
        const secondRefresh = service.refresh();

        expect(fetchUsage).toHaveBeenCalledTimes(1);
        releaseUsage({ providers: { test: { totalCount: 1 } } });

        await expect(firstRefresh).resolves.toMatchObject({ skipped: false });
        await expect(secondRefresh).resolves.toMatchObject({
            skipped: false,
            usageData: { providers: { test: { totalCount: 1 } } }
        });
    });

    test('factory preserves startupRun=true when the repeating interval is started', async () => {
        const refresh = jest.spyOn(UsageCacheAutoRefreshService.prototype, 'refresh').mockResolvedValue({ skipped: false });
        const service = startUsageCacheAutoRefreshService({
            USAGE_CACHE_AUTO_REFRESH: { enabled: true, startupRun: true, interval: 60_000 }
        }, {});

        await jest.advanceTimersByTimeAsync(100);

        expect(refresh).toHaveBeenCalledTimes(1);
        await service.stop();
        refresh.mockRestore();
    });

    test('factory does not schedule startup refresh when startupRun=false', async () => {
        const refresh = jest.spyOn(UsageCacheAutoRefreshService.prototype, 'refresh').mockResolvedValue({ skipped: false });
        const service = startUsageCacheAutoRefreshService({
            USAGE_CACHE_AUTO_REFRESH: { enabled: true, startupRun: false, interval: 60_000 }
        }, {});

        await jest.advanceTimersByTimeAsync(100);

        expect(refresh).not.toHaveBeenCalled();
        await service.stop();
        refresh.mockRestore();
    });

    test('stop waits for an active refresh to finish', async () => {
        let releaseUsage;
        const usageBarrier = new Promise(resolve => {
            releaseUsage = resolve;
        });
        const fetchUsage = jest.fn(() => usageBarrier);
        const persistUsage = jest.fn().mockResolvedValue();
        const service = new UsageCacheAutoRefreshService({
            config: {},
            providerPoolManager: {},
            fetchUsage,
            persistUsage
        });
        service.start(60_000);
        const refreshPromise = service.refresh();
        await Promise.resolve();

        let stopped = false;
        const stopPromise = service.stop().then(() => { stopped = true; });
        await Promise.resolve();

        expect(service.timer).toBeNull();
        expect(stopped).toBe(false);

        releaseUsage({ providers: {} });
        await refreshPromise;
        await stopPromise;
        expect(stopped).toBe(true);
    });

    test('stop cancels the delayed startup refresh before it can begin', async () => {
        const fetchUsage = jest.fn().mockResolvedValue({ providers: {} });
        const service = new UsageCacheAutoRefreshService({
            config: {},
            providerPoolManager: {},
            fetchUsage,
            persistUsage: jest.fn().mockResolvedValue()
        });
        service.scheduleStartupRefresh(100);

        await service.stop();
        await jest.advanceTimersByTimeAsync(100);

        expect(fetchUsage).not.toHaveBeenCalled();
    });
});
