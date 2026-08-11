import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => [])
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('provider pool persistence batching', () => {
    test('uses one ten-second batch timer for sustained updates', async () => {
        const manager = new ProviderPoolManager({}, { logLevel: 'error' });
        const flush = jest.spyOn(manager, '_flushPendingSaves').mockResolvedValue();

        manager._debouncedSave('gemini-antigravity');
        await jest.advanceTimersByTimeAsync(5_000);
        manager._debouncedSave('gemini-antigravity');
        await jest.advanceTimersByTimeAsync(4_999);
        expect(flush).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(flush).toHaveBeenCalledTimes(1);
    });
});
