const DEFAULT_STOP_TIMEOUT_MS = 30000;

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

export class WorkerStopError extends Error {
    constructor(message, {
        code = null,
        signal = null,
        forced = false,
        deliveryErrors = [],
        cause
    } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'WorkerStopError';
        this.code = code;
        this.signal = signal;
        this.forced = forced;
        this.deliveryErrors = deliveryErrors;
    }
}

export class WorkerRestartCancelledError extends Error {
    constructor(message = 'Worker restart was superseded by a newer lifecycle intent') {
        super(message);
        this.name = 'WorkerRestartCancelledError';
    }
}

/**
 * Create the master-side worker stop state machine.
 *
 * A graceful stop starts with IPC only. SIGTERM is reserved for an unusable
 * IPC channel, while SIGKILL is reserved for the final deadline.
 */
export function createWorkerLifecycle({
    getWorker = () => null,
    clearWorker = () => {},
    setStopping = () => {},
    logger = console,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout
} = {}) {
    let stopPromise = null;
    let stopping = false;
    let intentGeneration = 0;

    const updateStopping = value => {
        stopping = value;
        setStopping(value);
    };

    const isStopping = () => stopping;

    const shouldAutoRestart = ({ code, isRestarting = false } = {}) => (
        !stopping && !isRestarting && code !== 0
    );

    const beginRestartIntent = () => {
        intentGeneration += 1;
        return intentGeneration;
    };

    const beginStartIntent = () => {
        intentGeneration += 1;
        return intentGeneration;
    };

    const isIntentCurrent = intent => intent === intentGeneration;

    const stop = ({ graceful = true, intent = null } = {}) => {
        if (intent === null || intent === undefined) {
            intentGeneration += 1;
        }

        if (stopPromise) {
            return stopPromise;
        }

        const worker = getWorker();
        if (!worker) {
            logger?.info?.('[Master] No worker process to stop');
            return Promise.resolve({
                success: true,
                alreadyStopped: true,
                code: 0,
                signal: null,
                forced: false
            });
        }

        logger?.info?.(`[Master] Stopping worker process, PID: ${worker.pid}`);
        updateStopping(true);

        let resolveStop;
        let rejectStop;
        let workerExited = false;
        let promiseSettled = false;
        let forced = !graceful;
        let fallbackSent = false;
        let timeout = null;
        const deliveryErrors = [];

        stopPromise = new Promise((resolve, reject) => {
            resolveStop = resolve;
            rejectStop = reject;
        });
        const operationPromise = stopPromise;

        const createStopError = (message, {
            code = null,
            signal = null,
            cause
        } = {}) => new WorkerStopError(message, {
            code,
            signal,
            forced,
            deliveryErrors: [...deliveryErrors],
            cause
        });

        const resolveOperation = result => {
            if (promiseSettled) return;
            promiseSettled = true;
            resolveStop(result);
        };

        const rejectOperation = error => {
            if (promiseSettled) return;
            promiseSettled = true;
            rejectStop(error);
        };

        const finish = (code, signal) => {
            if (workerExited) return;
            workerExited = true;

            if (timeout !== null) {
                cancelTimeout(timeout);
                timeout = null;
            }

            clearWorker(worker);
            updateStopping(false);
            stopPromise = null;

            const result = {
                success: code === 0 && !forced,
                code,
                signal,
                forced,
                deliveryErrors: [...deliveryErrors]
            };

            if (promiseSettled) {
                logger?.info?.(
                    `[Master] Worker exited after stop failure was already reported (code=${code}, signal=${signal ?? 'none'})`
                );
                return;
            }

            if (result.success) {
                logger?.info?.('[Master] Worker process stopped cleanly');
                resolveOperation(result);
                return;
            }

            rejectOperation(createStopError(
                `Worker stopped unsuccessfully (code=${code}, signal=${signal ?? 'none'}, forced=${forced})`,
                { code, signal }
            ));
        };

        const recordDeliveryFailure = (signal, reason, error) => {
            const failure = {
                signal,
                reason,
                message: errorMessage(error)
            };
            deliveryErrors.push(failure);
            logger?.error?.(
                `[Master] Failed to send ${signal} while ${reason}: ${failure.message}`
            );
            return failure;
        };

        const sendSignal = (signal, reason, { final = false } = {}) => {
            let deliveryError = null;

            try {
                const sent = worker.kill(signal);
                if (sent === false) {
                    deliveryError = new Error(`worker.kill(${signal}) returned false`);
                }
            } catch (error) {
                deliveryError = error;
            }

            if (!deliveryError) return true;

            recordDeliveryFailure(signal, reason, deliveryError);

            if (final) {
                rejectOperation(createStopError(
                    `Failed to deliver final ${signal} while ${reason}: ${errorMessage(deliveryError)}`,
                    { signal, cause: deliveryError }
                ));
            }

            return false;
        };

        const fallbackToSigterm = error => {
            if (workerExited || fallbackSent || forced) return;
            fallbackSent = true;
            logger?.warn?.(
                `[Master] Graceful shutdown IPC unavailable; falling back to SIGTERM: ${errorMessage(error)}`
            );
            sendSignal('SIGTERM', 'falling back from graceful IPC shutdown');
        };

        worker.once('exit', finish);

        timeout = scheduleTimeout(() => {
            timeout = null;
            if (workerExited) return;
            forced = true;
            logger?.error?.(
                `[Master] Worker did not stop within ${stopTimeoutMs}ms; sending SIGKILL`
            );
            sendSignal(
                'SIGKILL',
                'enforcing the worker stop deadline',
                { final: true }
            );
        }, stopTimeoutMs);

        if (!graceful) {
            sendSignal('SIGKILL', 'performing a non-graceful stop');
            return operationPromise;
        }

        if (worker.connected === false || typeof worker.send !== 'function') {
            fallbackToSigterm(new Error('worker IPC channel is not connected'));
            return operationPromise;
        }

        try {
            worker.send({ type: 'shutdown' }, error => {
                if (error) {
                    fallbackToSigterm(error);
                }
            });
        } catch (error) {
            fallbackToSigterm(error);
        }

        return operationPromise;
    };

    return {
        beginRestartIntent,
        beginStartIntent,
        isStopping,
        isIntentCurrent,
        shouldAutoRestart,
        stop
    };
}

/**
 * Build the explicit master start entry so it supersedes queued restarts.
 */
export function createExplicitWorkerStarter({
    lifecycle,
    hasWorker = () => false,
    startWorker
}) {
    return function startExplicitWorker() {
        if (hasWorker()) {
            return {
                success: false,
                message: 'Worker already running'
            };
        }

        const intent = lifecycle.beginStartIntent();
        const worker = startWorker();

        return {
            success: true,
            intent,
            worker
        };
    };
}

/**
 * Coordinate process-level shutdown so repeated signals share one outcome.
 */
export function createMasterShutdownCoordinator({
    stopWorker,
    exit = code => process.exit(code),
    logger = console
} = {}) {
    let shutdownPromise = null;
    let requestedExitCode = 0;

    return function requestMasterShutdown({ exitCode = 0, trigger = 'unknown' } = {}) {
        if (exitCode !== 0) {
            requestedExitCode = 1;
        }

        if (shutdownPromise) {
            return shutdownPromise;
        }

        logger?.info?.(`[Master] Shutdown requested by ${trigger}`);

        let resolveShutdown;
        let rejectShutdown;
        shutdownPromise = new Promise((resolve, reject) => {
            resolveShutdown = resolve;
            rejectShutdown = reject;
        });

        const execute = async () => {
            try {
                await stopWorker();
            } catch (error) {
                requestedExitCode = 1;
                logger?.error?.(`[Master] Worker shutdown failed: ${errorMessage(error)}`);
            }

            const finalExitCode = requestedExitCode;
            exit(finalExitCode);
            return finalExitCode;
        };

        execute().then(resolveShutdown, rejectShutdown);
        return shutdownPromise;
    };
}

/**
 * Start a replacement only after the old worker completed a clean stop.
 */
export async function restartAfterGracefulStop({
    stopWorker,
    startWorker,
    delayMs = 0,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    canStart = () => true
}) {
    if (!canStart()) {
        throw new WorkerRestartCancelledError();
    }

    await stopWorker();

    if (!canStart()) {
        throw new WorkerRestartCancelledError();
    }

    await wait(delayMs);

    if (!canStart()) {
        throw new WorkerRestartCancelledError();
    }

    return startWorker();
}
