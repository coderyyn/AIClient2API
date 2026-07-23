export function createAsyncActivityTracker() {
    let activeCount = 0;
    const idleWaiters = new Set();

    const settleOne = () => {
        activeCount -= 1;
        if (activeCount !== 0) return;

        for (const resolve of idleWaiters) {
            resolve();
        }
        idleWaiters.clear();
    };

    const run = (operation, ...args) => {
        activeCount += 1;

        let result;
        let isThenable;
        try {
            result = operation(...args);
            isThenable = result !== null &&
                (typeof result === 'object' || typeof result === 'function') &&
                typeof result.then === 'function';
        } catch (error) {
            settleOne();
            throw error;
        }

        if (!isThenable) {
            settleOne();
            return result;
        }

        return Promise.resolve(result).then(
            value => {
                settleOne();
                return value;
            },
            error => {
                settleOne();
                throw error;
            }
        );
    };

    const wrapHttpHandler = handler => (request, response) => run(async () => {
        if (!response || typeof response.once !== 'function' || response.writableFinished || response.destroyed) {
            return handler(request, response);
        }

        let removeResponseListeners = () => {};
        const responseSettled = new Promise(resolve => {
            const finish = () => {
                removeResponseListeners();
                resolve();
            };
            removeResponseListeners = () => {
                response.off?.('finish', finish);
                response.off?.('close', finish);
            };
            response.once('finish', finish);
            response.once('close', finish);
        });

        try {
            const result = await handler(request, response);
            if (!response.writableFinished && !response.destroyed) {
                await responseSettled;
            }
            return result;
        } catch (error) {
            removeResponseListeners();
            throw error;
        } finally {
            removeResponseListeners();
        }
    });

    return {
        run,
        wrap: handler => (...args) => run(handler, ...args),
        wrapHttpHandler,
        waitForIdle() {
            if (activeCount === 0) {
                return Promise.resolve();
            }
            return new Promise(resolve => {
                idleWaiters.add(resolve);
            });
        },
        getActiveCount: () => activeCount
    };
}

export function createStartupShutdownGate({ logger = console } = {}) {
    let shutdownRequested = false;

    return {
        requestShutdown() {
            shutdownRequested = true;
        },
        isShutdownRequested() {
            return shutdownRequested;
        },
        shouldAbort(stage) {
            if (!shutdownRequested) return false;
            logger?.info?.(`[Initialization] Shutdown requested; stopping before ${stage}`);
            return true;
        }
    };
}
