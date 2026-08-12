import { waitForCoordinationReady } from '../src/runtime/runtime-coordination-readiness.js';

test('waits until the recovery barrier reports ready', async () => {
    const synchronize = jest.fn()
        .mockResolvedValueOnce({ ready: false, readyWorkers: 1 })
        .mockResolvedValueOnce({ ready: true, readyWorkers: 3 });
    const state = await waitForCoordinationReady({ synchronize }, { retryMs: 0 });
    expect(state.ready).toBe(true);
    expect(synchronize).toHaveBeenCalledTimes(2);
});
