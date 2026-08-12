export function createWorkerShutdownHandlers({
    requestShutdown = () => {},
    isRetryableNetworkError = () => false,
    sendStatus = () => {},
    getStatus = () => ({}),
    logger = console,
    onRuntimeMessage = () => false
} = {}) {
    const requestGracefulShutdown = () => requestShutdown(0);
    const requestFatalShutdown = () => requestShutdown(1);

    return {
        onMessage(message) {
            if (!message?.type) return;
            if (onRuntimeMessage(message) === true) return;
            logger?.info?.('[Worker] Received message from master:', message.type);

            if (message.type === 'shutdown') {
                logger?.info?.('[Worker] Shutdown requested by master');
                requestGracefulShutdown();
                return;
            }

            if (message.type === 'status') {
                sendStatus(getStatus());
                return;
            }

            logger?.info?.('[Worker] Unknown message type:', message.type);
        },

        onDisconnect() {
            logger?.info?.('[Worker] Disconnected from master, shutting down...');
            requestGracefulShutdown();
        },

        onSigterm() {
            logger?.info?.('[Server] Received SIGTERM');
            requestGracefulShutdown();
        },

        onSigint() {
            logger?.info?.('[Server] Received SIGINT');
            requestGracefulShutdown();
        },

        onUncaughtException(error) {
            logger?.error?.('[Server] Uncaught exception:', error);
            if (isRetryableNetworkError(error)) {
                logger?.warn?.('[Server] Network error detected, continuing operation...');
                return;
            }

            logger?.error?.('[Server] Fatal error detected, initiating shutdown...');
            requestFatalShutdown();
        },

        onUnhandledRejection(reason, promise) {
            logger?.error?.('[Server] Unhandled rejection at:', promise, 'reason:', reason);
            if (reason && isRetryableNetworkError(reason)) {
                logger?.warn?.('[Server] Network error in promise rejection, continuing operation...');
                return;
            }

            logger?.error?.('[Server] Fatal promise rejection detected, initiating shutdown...');
            requestFatalShutdown();
        },

        onStartFailure(error) {
            logger?.error?.('[Server] Failed to start server:', error);
            requestFatalShutdown();
        }
    };
}

export function registerWorkerShutdownHandlers({
    processRef = process,
    isWorkerProcess = false,
    ...dependencies
} = {}) {
    const handlers = createWorkerShutdownHandlers(dependencies);

    processRef.on('SIGTERM', handlers.onSigterm);
    processRef.on('SIGINT', handlers.onSigint);
    processRef.on('uncaughtException', handlers.onUncaughtException);
    processRef.on('unhandledRejection', handlers.onUnhandledRejection);

    if (isWorkerProcess) {
        processRef.on('message', handlers.onMessage);
        processRef.on('disconnect', handlers.onDisconnect);
    }

    return handlers;
}
