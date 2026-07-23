const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 25_000;

function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Build a single-use worker shutdown state machine.
 *
 * The returned function is intentionally not async so repeated callers receive
 * the exact same Promise instance.
 */
export function createShutdownCoordinator({
    getServer = () => null,
    onShutdownRequested = () => {},
    waitForStartup = async () => {},
    waitForInFlightHandlers = async () => {},
    stopBackgroundServices = async () => {},
    destroyPlugins = async () => {},
    stopTlsSidecar = async () => {},
    exit = code => process.exit(code),
    logger = console,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout
} = {}) {
    let shutdownPromise = null;
    let requestedExitCode = 0;
    let exitCalled = false;
    let deadlineReached = false;

    const markFailure = (stage, error) => {
        requestedExitCode = 1;
        logger?.error?.(`[Shutdown] ${stage} failed: ${errorMessage(error)}`);
    };

    const runCleanupStep = async (stage, operation) => {
        try {
            await operation();
        } catch (error) {
            markFailure(stage, error);
        }
    };

    const closeIngress = async () => {
        const server = getServer();
        if (!server || typeof server.close !== 'function') {
            return;
        }

        await new Promise(resolve => {
            let settled = false;
            let drainTimer = null;

            const finish = error => {
                if (settled) return;
                settled = true;
                if (drainTimer !== null) {
                    cancelTimeout(drainTimer);
                }
                if (error) {
                    markFailure('HTTP ingress close', error);
                }
                resolve();
            };

            drainTimer = scheduleTimeout(() => {
                if (settled) return;

                markFailure(
                    'HTTP drain',
                    new Error(`timed out after ${drainTimeoutMs}ms`)
                );

                if (typeof server.closeAllConnections === 'function') {
                    try {
                        server.closeAllConnections();
                    } catch (error) {
                        markFailure('forcing HTTP connections closed', error);
                    }
                }

                finish();
            }, drainTimeoutMs);

            try {
                server.close(finish);
            } catch (error) {
                finish(error);
            }
        });
    };

    const runCleanup = async () => {
        await runCleanupStep('HTTP ingress close', closeIngress);
        if (deadlineReached) return;

        await runCleanupStep('startup settle', waitForStartup);
        if (deadlineReached) return;

        await runCleanupStep('in-flight request drain', waitForInFlightHandlers);
        if (deadlineReached) return;

        await runCleanupStep('background service stop', stopBackgroundServices);
        if (deadlineReached) return;

        await runCleanupStep('plugin destruction', destroyPlugins);
        if (deadlineReached) return;

        await runCleanupStep('TLS sidecar stop', stopTlsSidecar);
    };

    const executeShutdown = async () => {
        let deadlineTimer = null;
        const deadline = new Promise(resolve => {
            deadlineTimer = scheduleTimeout(() => {
                deadlineReached = true;
                markFailure(
                    'total shutdown deadline',
                    new Error(`timed out after ${totalTimeoutMs}ms`)
                );
                resolve('deadline');
            }, totalTimeoutMs);
        });

        const cleanup = runCleanup()
            .catch(error => {
                markFailure('unexpected cleanup', error);
            })
            .then(() => 'cleanup');

        const completedBy = await Promise.race([cleanup, deadline]);
        if (completedBy === 'cleanup' && deadlineTimer !== null) {
            cancelTimeout(deadlineTimer);
        }

        const finalExitCode = requestedExitCode === 0 ? 0 : 1;
        if (!exitCalled) {
            exitCalled = true;
            exit(finalExitCode);
        }
        return finalExitCode;
    };

    return function requestShutdown({ exitCode = 0 } = {}) {
        if (exitCode !== 0) {
            requestedExitCode = 1;
        }

        if (shutdownPromise) {
            return shutdownPromise;
        }

        onShutdownRequested();
        logger?.info?.('[Shutdown] Initiating graceful shutdown');

        let resolveShutdown;
        let rejectShutdown;
        shutdownPromise = new Promise((resolve, reject) => {
            resolveShutdown = resolve;
            rejectShutdown = reject;
        });

        executeShutdown().then(resolveShutdown, rejectShutdown);
        return shutdownPromise;
    };
}
