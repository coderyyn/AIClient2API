import { describe, expect, jest, test } from '@jest/globals';
import { createWorkerShutdownHandlers, registerWorkerShutdownHandlers } from '../src/services/worker-shutdown-handlers.js';

function createLogger() {
    return {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
}

describe('worker shutdown event handlers', () => {
    test('routes IPC shutdown, signals, and disconnect through the injected shutdown function', () => {
        const requestShutdown = jest.fn();
        const handlers = createWorkerShutdownHandlers({ requestShutdown, logger: createLogger() });

        handlers.onMessage({ type: 'shutdown' });
        handlers.onSigterm();
        handlers.onSigint();
        handlers.onDisconnect();

        expect(requestShutdown).toHaveBeenCalledTimes(4);
        expect(requestShutdown).toHaveBeenNthCalledWith(1, 0);
        expect(requestShutdown).toHaveBeenNthCalledWith(2, 0);
        expect(requestShutdown).toHaveBeenNthCalledWith(3, 0);
        expect(requestShutdown).toHaveBeenNthCalledWith(4, 0);
    });

    test('keeps retryable network errors alive but shuts down on fatal errors with the original Error object', () => {
        const requestShutdown = jest.fn();
        const logger = createLogger();
        const retryableError = new Error('temporary network failure');
        const fatalError = new Error('fatal worker failure');
        const handlers = createWorkerShutdownHandlers({
            requestShutdown,
            logger,
            isRetryableNetworkError: error => error === retryableError
        });

        handlers.onUncaughtException(retryableError);
        expect(requestShutdown).not.toHaveBeenCalled();

        handlers.onUncaughtException(fatalError);
        expect(requestShutdown).toHaveBeenCalledTimes(1);
        expect(requestShutdown).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalledWith('[Server] Uncaught exception:', fatalError);
    });

    test('handles status messages and fatal unhandled rejections through the same injected path', () => {
        const requestShutdown = jest.fn();
        const sendStatus = jest.fn();
        const logger = createLogger();
        const status = { pid: 123, uptime: 4 };
        const handlers = createWorkerShutdownHandlers({
            requestShutdown,
            sendStatus,
            getStatus: () => status,
            logger
        });
        const rejection = new Error('unhandled worker failure');
        const promise = Promise.reject(rejection);
        promise.catch(() => {});

        handlers.onMessage({ type: 'status' });
        handlers.onUnhandledRejection(rejection, promise);

        expect(sendStatus).toHaveBeenCalledWith(status);
        expect(requestShutdown).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalledWith('[Server] Unhandled rejection at:', promise, 'reason:', rejection);
    });

    test('registers the concrete handlers on an injected process object and routes startup failure', () => {
        const listeners = new Map();
        const processRef = {
            on: jest.fn((event, listener) => listeners.set(event, listener))
        };
        const requestShutdown = jest.fn();
        const logger = createLogger();
        const handlers = registerWorkerShutdownHandlers({
            processRef,
            requestShutdown,
            logger,
            isWorkerProcess: true
        });

        expect(processRef.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(processRef.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(processRef.on).toHaveBeenCalledWith('message', expect.any(Function));
        expect(processRef.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(processRef.on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
        expect(processRef.on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
        handlersForTest(listeners, 'SIGTERM');
        handlersForTest(listeners, 'SIGINT');
        handlersForTest(listeners, 'message', { type: 'shutdown' });
        handlersForTest(listeners, 'disconnect');

        const fatalError = new Error('fatal registered listener');
        handlersForTest(listeners, 'uncaughtException', fatalError);
        handlersForTest(listeners, 'unhandledRejection', fatalError, Promise.resolve());

        const startupError = new Error('startup failed');
        handlers.onStartFailure(startupError);
        expect(requestShutdown.mock.calls).toEqual([
            [0],
            [0],
            [0],
            [0],
            [1],
            [1],
            [1]
        ]);
    });
});

function handlersForTest(listeners, event, ...args) {
    const listener = listeners.get(event);
    if (listener) return listener(...args);
    throw new Error(`missing listener: ${event}`);
}
