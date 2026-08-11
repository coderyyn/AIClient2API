import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

describe('usage refresh feedback', () => {
    beforeAll(() => {
        globalThis.window = {
            location: { origin: 'http://localhost' }
        };
        globalThis.localStorage = {
            getItem: jest.fn(() => null),
            setItem: jest.fn(),
            removeItem: jest.fn()
        };
    });

    afterAll(() => {
        delete globalThis.window;
        delete globalThis.localStorage;
    });

    test('waits for the background refresh before reporting completion', async () => {
        const usageManager = await import('../static/app/usage-manager.js');

        expect(typeof usageManager.waitForUsageRefreshCompletion).toBe('function');

        const fetchUsage = jest.fn()
            .mockResolvedValueOnce({ refreshPending: true, timestamp: 'old' })
            .mockResolvedValueOnce({ refreshPending: false, timestamp: 'fresh' });
        const sleep = jest.fn().mockResolvedValue(undefined);

        const result = await usageManager.waitForUsageRefreshCompletion({
            fetchUsage,
            sleep,
            intervalMs: 1,
            timeoutMs: 1000
        });

        expect(result).toEqual({
            completed: true,
            data: { refreshPending: false, timestamp: 'fresh' }
        });
        expect(fetchUsage).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    test('does not claim success when the background refresh is still running at timeout', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        let now = 0;
        const fetchUsage = jest.fn().mockResolvedValue({ refreshPending: true, timestamp: 'old' });
        const sleep = jest.fn().mockImplementation(async () => { now += 50; });

        const result = await usageManager.waitForUsageRefreshCompletion({
            fetchUsage,
            sleep,
            now: () => now,
            intervalMs: 50,
            timeoutMs: 100
        });

        expect(result).toEqual({
            completed: false,
            data: { refreshPending: true, timestamp: 'old' }
        });
        expect(fetchUsage).toHaveBeenCalledTimes(2);
    });
});
