import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        error: jest.fn()
    }
}));

import { withFileLock } from '../src/utils/file-lock.js';

afterEach(() => {
    jest.useRealTimers();
});

describe('file lock timeout cleanup', () => {
    test('clears the timeout timer after a successful operation', async () => {
        jest.useFakeTimers();

        await expect(withFileLock('timer-cleanup-success', async () => 'ok')).resolves.toBe('ok');

        expect(jest.getTimerCount()).toBe(0);
    });

    test('clears the timeout timer after a failed operation', async () => {
        jest.useFakeTimers();

        await expect(withFileLock('timer-cleanup-failure', async () => {
            throw new Error('expected failure');
        })).rejects.toThrow('expected failure');

        expect(jest.getTimerCount()).toBe(0);
    });
});
