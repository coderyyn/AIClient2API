import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import {
    createExplicitWorkerStarter,
    createMasterShutdownCoordinator,
    createWorkerLifecycle,
    restartAfterGracefulStop
} from '../src/core/master-worker-lifecycle.js';

class FakeWorker extends EventEmitter {
    constructor({ connected = true } = {}) {
        super();
        this.pid = 4242;
        this.connected = connected;
        this.sendCallback = null;
        this.send = jest.fn((_message, callback) => {
            this.sendCallback = callback;
            return true;
        });
        this.kill = jest.fn(() => true);
    }

    finishExit(code = 0, signal = null) {
        this.emit('exit', code, signal);
    }
}

function createHarness({ worker = new FakeWorker(), ...overrides } = {}) {
    let currentWorker = worker;
    const stoppingStates = [];
    const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
    const lifecycle = createWorkerLifecycle({
        getWorker: () => currentWorker,
        clearWorker: stoppedWorker => {
            if (currentWorker === stoppedWorker) {
                currentWorker = null;
            }
        },
        setStopping: value => stoppingStates.push(value),
        logger,
        stopTimeoutMs: 30000,
        ...overrides
    });

    return { lifecycle, logger, stoppingStates, worker };
}

afterEach(() => {
    jest.useRealTimers();
});

describe('master worker lifecycle', () => {
    test('starts graceful stop with IPC only and resolves after a clean worker exit', async () => {
        const { lifecycle, stoppingStates, worker } = createHarness();

        const stopPromise = lifecycle.stop({ graceful: true });

        expect(worker.send).toHaveBeenCalledWith(
            { type: 'shutdown' },
            expect.any(Function)
        );
        expect(worker.kill).not.toHaveBeenCalled();
        expect(lifecycle.isStopping()).toBe(true);

        worker.finishExit(0);

        await expect(stopPromise).resolves.toMatchObject({
            success: true,
            code: 0,
            signal: null,
            forced: false
        });
        expect(stoppingStates).toEqual([true, false]);
        expect(lifecycle.isStopping()).toBe(false);
    });

    test('falls back to SIGTERM when the IPC send callback reports failure', async () => {
        const { lifecycle, worker } = createHarness();

        const stopPromise = lifecycle.stop({ graceful: true });
        worker.sendCallback(new Error('IPC channel closed'));

        expect(worker.kill).toHaveBeenCalledTimes(1);
        expect(worker.kill).toHaveBeenCalledWith('SIGTERM');

        worker.finishExit(0);
        await expect(stopPromise).resolves.toMatchObject({ success: true });
    });

    test('uses SIGTERM without attempting IPC when the worker is disconnected', async () => {
        const worker = new FakeWorker({ connected: false });
        const { lifecycle } = createHarness({ worker });

        const stopPromise = lifecycle.stop({ graceful: true });

        expect(worker.send).not.toHaveBeenCalled();
        expect(worker.kill).toHaveBeenCalledWith('SIGTERM');

        worker.finishExit(0);
        await expect(stopPromise).resolves.toMatchObject({ success: true });
    });

    test('sends SIGKILL only after the graceful deadline and reports forced stop failure', async () => {
        jest.useFakeTimers();
        const { lifecycle, worker } = createHarness();
        const stopPromise = lifecycle.stop({ graceful: true });
        const rejection = expect(stopPromise).rejects.toMatchObject({
            name: 'WorkerStopError',
            code: null,
            signal: 'SIGKILL',
            forced: true
        });

        await jest.advanceTimersByTimeAsync(29999);
        expect(worker.kill).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(worker.kill).toHaveBeenCalledTimes(1);
        expect(worker.kill).toHaveBeenCalledWith('SIGKILL');

        worker.finishExit(null, 'SIGKILL');
        await rejection;
    });

    test('does not send a late SIGTERM after the SIGKILL deadline has fired', async () => {
        jest.useFakeTimers();
        const { lifecycle, worker } = createHarness();
        const stopPromise = lifecycle.stop({ graceful: true });
        const rejection = expect(stopPromise).rejects.toMatchObject({ forced: true });

        await jest.advanceTimersByTimeAsync(30000);
        worker.sendCallback(new Error('late IPC failure'));

        expect(worker.kill).toHaveBeenCalledTimes(1);
        expect(worker.kill).toHaveBeenCalledWith('SIGKILL');

        worker.finishExit(null, 'SIGKILL');
        await rejection;
    });

    test('returns one stop promise and suppresses auto-restart while stopping', async () => {
        const { lifecycle, worker } = createHarness();

        const first = lifecycle.stop({ graceful: true });
        const second = lifecycle.stop({ graceful: true });

        expect(second).toBe(first);
        expect(worker.send).toHaveBeenCalledTimes(1);
        expect(lifecycle.shouldAutoRestart({ code: 1, isRestarting: false })).toBe(false);

        worker.finishExit(0);
        await first;
    });

    test('rejects a graceful stop when the worker exits non-zero', async () => {
        const { lifecycle, worker } = createHarness();

        const stopPromise = lifecycle.stop({ graceful: true });
        const rejection = expect(stopPromise).rejects.toMatchObject({
            name: 'WorkerStopError',
            code: 1,
            signal: null,
            forced: false
        });

        worker.finishExit(1);
        await rejection;
    });

    test('allows auto-restart only for an unplanned non-zero exit', () => {
        const { lifecycle } = createHarness({ worker: null });

        expect(lifecycle.shouldAutoRestart({ code: 1, isRestarting: false })).toBe(true);
        expect(lifecycle.shouldAutoRestart({ code: 1, isRestarting: true })).toBe(false);
        expect(lifecycle.shouldAutoRestart({ code: 0, isRestarting: false })).toBe(false);
    });

    test.each([
        ['returns false', () => false],
        ['throws', () => {
            throw new Error('signal permission denied');
        }]
    ])('keeps the stop active when fallback SIGTERM %s and still reaches SIGKILL', async (_label, failSigterm) => {
        jest.useFakeTimers();
        const worker = new FakeWorker();
        worker.kill = jest.fn(signal => {
            if (signal === 'SIGTERM') {
                return failSigterm();
            }
            return true;
        });
        const { lifecycle } = createHarness({ worker });
        const stopPromise = lifecycle.stop({ graceful: true });
        const observedStop = stopPromise.catch(error => error);
        worker.sendCallback(new Error('IPC send failed'));

        expect(lifecycle.isStopping()).toBe(true);
        expect(lifecycle.shouldAutoRestart({ code: 1, isRestarting: false })).toBe(false);

        await jest.advanceTimersByTimeAsync(30000);

        expect(worker.kill.mock.calls).toEqual([
            ['SIGTERM'],
            ['SIGKILL']
        ]);
        expect(lifecycle.isStopping()).toBe(true);

        worker.finishExit(null, 'SIGKILL');
        await expect(observedStop).resolves.toMatchObject({
            name: 'WorkerStopError',
            signal: 'SIGKILL',
            forced: true,
            deliveryErrors: [expect.objectContaining({ signal: 'SIGTERM' })]
        });
        expect(lifecycle.isStopping()).toBe(false);
    });

    test('keeps restart suppression through a failed final SIGKILL until a late exit arrives', async () => {
        jest.useFakeTimers();
        const worker = new FakeWorker();
        worker.kill = jest.fn(() => false);
        const { lifecycle } = createHarness({ worker });
        let autoRestartDecision = null;
        worker.on('exit', code => {
            autoRestartDecision = lifecycle.shouldAutoRestart({
                code,
                isRestarting: false
            });
        });

        const stopPromise = lifecycle.stop({ graceful: true });
        const observedStop = stopPromise.catch(error => error);
        worker.sendCallback(new Error('IPC send failed'));

        await jest.advanceTimersByTimeAsync(30000);
        await expect(observedStop).resolves.toMatchObject({
            name: 'WorkerStopError',
            signal: 'SIGKILL',
            forced: true
        });

        expect(lifecycle.isStopping()).toBe(true);
        expect(lifecycle.stop({ graceful: true })).toBe(stopPromise);

        worker.finishExit(1);

        expect(autoRestartDecision).toBe(false);
        expect(lifecycle.isStopping()).toBe(false);
    });
});

describe('master shutdown coordination', () => {
    test('shares one shutdown promise and exits non-zero when worker shutdown fails', async () => {
        let rejectStop;
        const stopWorker = jest.fn(() => new Promise((_resolve, reject) => {
            rejectStop = reject;
        }));
        const exit = jest.fn();
        const shutdown = createMasterShutdownCoordinator({
            stopWorker,
            exit,
            logger: { info: jest.fn(), error: jest.fn() }
        });

        const first = shutdown({ trigger: 'SIGTERM' });
        const second = shutdown({ trigger: 'SIGINT' });

        expect(second).toBe(first);
        expect(stopWorker).toHaveBeenCalledTimes(1);

        rejectStop(new Error('plugin flush failed'));

        await expect(first).resolves.toBe(1);
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
    });

    test('raises the final exit code when a fatal request arrives during shutdown', async () => {
        let resolveStop;
        const stopWorker = jest.fn(() => new Promise(resolve => {
            resolveStop = resolve;
        }));
        const exit = jest.fn();
        const shutdown = createMasterShutdownCoordinator({
            stopWorker,
            exit,
            logger: { info: jest.fn(), error: jest.fn() }
        });

        const graceful = shutdown({ exitCode: 0, trigger: 'SIGTERM' });
        const fatal = shutdown({ exitCode: 1, trigger: 'fatal' });

        expect(fatal).toBe(graceful);
        resolveStop({ success: true });

        await expect(graceful).resolves.toBe(1);
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
    });
});

describe('worker restart sequencing', () => {
    test('explicit start entry invalidates a queued auto-restart without replacing the new worker', async () => {
        let currentWorker = null;
        const lifecycle = createWorkerLifecycle({
            getWorker: () => currentWorker,
            clearWorker: stoppedWorker => {
                if (currentWorker === stoppedWorker) {
                    currentWorker = null;
                }
            },
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        });
        const explicitWorker = new FakeWorker();
        const explicitStart = jest.fn(() => {
            currentWorker = explicitWorker;
            return explicitWorker;
        });
        const startEntry = createExplicitWorkerStarter({
            lifecycle,
            hasWorker: () => currentWorker !== null,
            startWorker: explicitStart
        });
        const staleRestartIntent = lifecycle.beginRestartIntent();
        let releaseDelay;
        const wait = jest.fn(() => new Promise(resolve => {
            releaseDelay = resolve;
        }));
        const staleReplacementStart = jest.fn();

        const restartPromise = restartAfterGracefulStop({
            stopWorker: () => lifecycle.stop({ intent: staleRestartIntent }),
            startWorker: staleReplacementStart,
            delayMs: 1000,
            wait,
            canStart: () => lifecycle.isIntentCurrent(staleRestartIntent)
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(wait).toHaveBeenCalledWith(1000);

        const startResult = startEntry();
        expect(startResult).toMatchObject({ success: true });
        expect(explicitStart).toHaveBeenCalledTimes(1);

        releaseDelay();
        await expect(restartPromise).rejects.toMatchObject({
            name: 'WorkerRestartCancelledError'
        });
        expect(staleReplacementStart).not.toHaveBeenCalled();
        expect(currentWorker).toBe(explicitWorker);
    });

    test('does not stop a current worker when a queued restart intent is already stale', async () => {
        const stopWorker = jest.fn(async () => ({ success: true }));
        const startWorker = jest.fn();

        await expect(restartAfterGracefulStop({
            stopWorker,
            startWorker,
            delayMs: 0,
            wait: jest.fn(async () => {}),
            canStart: () => false
        })).rejects.toMatchObject({
            name: 'WorkerRestartCancelledError'
        });

        expect(stopWorker).not.toHaveBeenCalled();
        expect(startWorker).not.toHaveBeenCalled();
    });

    test('starts a replacement when the restart intent remains current', async () => {
        const { lifecycle } = createHarness({ worker: null });
        const restartIntent = lifecycle.beginRestartIntent();
        const startWorker = jest.fn(() => ({ pid: 5150 }));

        await expect(restartAfterGracefulStop({
            stopWorker: () => lifecycle.stop({
                graceful: true,
                intent: restartIntent
            }),
            startWorker,
            delayMs: 0,
            wait: jest.fn(async () => {}),
            canStart: () => lifecycle.isIntentCurrent(restartIntent)
        })).resolves.toEqual({ pid: 5150 });

        expect(startWorker).toHaveBeenCalledTimes(1);
    });

    test('cancels a replacement when a newer stop intent arrives during restart delay', async () => {
        const { lifecycle } = createHarness({ worker: null });
        const restartIntent = lifecycle.beginRestartIntent();
        let releaseDelay;
        const wait = jest.fn(() => new Promise(resolve => {
            releaseDelay = resolve;
        }));
        const startWorker = jest.fn();

        const restartPromise = restartAfterGracefulStop({
            stopWorker: () => lifecycle.stop({
                graceful: true,
                intent: restartIntent
            }),
            startWorker,
            delayMs: 1000,
            wait,
            canStart: () => lifecycle.isIntentCurrent(restartIntent)
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(wait).toHaveBeenCalledWith(1000);

        await lifecycle.stop({ graceful: true });
        releaseDelay();

        await expect(restartPromise).rejects.toMatchObject({
            name: 'WorkerRestartCancelledError'
        });
        expect(startWorker).not.toHaveBeenCalled();
    });

    test('does not start a replacement when graceful stop fails', async () => {
        const stopError = new Error('worker flush failed');
        const stopWorker = jest.fn(async () => {
            throw stopError;
        });
        const startWorker = jest.fn();
        const wait = jest.fn(async () => {});

        await expect(restartAfterGracefulStop({
            stopWorker,
            startWorker,
            delayMs: 1000,
            wait
        })).rejects.toBe(stopError);

        expect(wait).not.toHaveBeenCalled();
        expect(startWorker).not.toHaveBeenCalled();
    });
});
