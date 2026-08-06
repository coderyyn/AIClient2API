function responseChunkBytes(chunk, encoding) {
    if (chunk === undefined || chunk === null) return 0;
    if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength;
    return Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

/**
 * Observe the response lifecycle without retaining response bodies.
 * The completion callback is deferred one event-loop turn so content hooks that
 * run immediately after res.end() can attach provider/model context first.
 */
export function instrumentResponseForAudit(res, onComplete, { autoFinalize = true } = {}) {
    let finalized = false;
    let observedResult = null;
    let completionPromise = null;
    let responseBytes = 0;
    let eligible = false;
    let normalizedPath = null;

    const originalWriteHead = typeof res.writeHead === 'function' ? res.writeHead : null;
    const originalWrite = typeof res.write === 'function' ? res.write : null;
    const originalEnd = typeof res.end === 'function' ? res.end : null;

    if (originalWriteHead) {
        res.writeHead = function auditedWriteHead(statusCode, ...args) {
            if (Number.isInteger(Number(statusCode))) this.statusCode = Number(statusCode);
            return originalWriteHead.call(this, statusCode, ...args);
        };
    }

    if (originalWrite) {
        res.write = function auditedWrite(chunk, encoding, callback) {
            responseBytes += responseChunkBytes(chunk, encoding);
            return originalWrite.call(this, chunk, encoding, callback);
        };
    }

    if (originalEnd) {
        res.end = function auditedEnd(chunk, encoding, callback) {
            if (typeof chunk === 'function') {
                return originalEnd.call(this, chunk);
            }
            responseBytes += responseChunkBytes(chunk, encoding);
            if (typeof encoding === 'function') {
                return originalEnd.call(this, chunk, encoding);
            }
            return originalEnd.call(this, chunk, encoding, callback);
        };
    }

    const emitCompletion = () => {
        if (finalized) return completionPromise;
        finalized = true;
        if (!eligible || typeof onComplete !== 'function') return Promise.resolve();
        const result = observedResult || {
            completed: Boolean(res.writableFinished || res.writableEnded),
            clientAborted: false,
            errorClass: null
        };
        const response = {
            httpStatus: Number.isInteger(Number(res.statusCode)) ? Number(res.statusCode) : null,
            bytes: responseBytes,
            completed: Boolean(result.completed),
            clientAborted: Boolean(result.clientAborted),
            hasImageResult: null
        };
        completionPromise = Promise.resolve(onComplete({ normalizedPath, response, errorClass: result.errorClass })).catch(() => {});
        return completionPromise;
    };

    const observe = ({ completed, clientAborted, errorClass = null }) => {
        const alreadyAborted = observedResult?.clientAborted === true;
        if (!observedResult || clientAborted || (!alreadyAborted && errorClass)) {
            observedResult = { completed, clientAborted, errorClass };
        }
        if (autoFinalize) return emitCompletion();
        return completionPromise;
    };

    const onFinish = () => observe({ completed: true, clientAborted: false });
    const onClose = () => {
        if (!res.writableFinished) observe({ completed: false, clientAborted: true, errorClass: 'client_aborted' });
    };
    const onError = () => observe({ completed: false, clientAborted: false, errorClass: 'response_stream_error' });

    res.on?.('finish', onFinish);
    res.on?.('close', onClose);
    res.on?.('error', onError);

    return {
        markEligible() {
            eligible = true;
        },
        setNormalizedPath(path) {
            normalizedPath = path || null;
        },
        complete() {
            return emitCompletion();
        },
        dispose() {
            res.off?.('finish', onFinish);
            res.off?.('close', onClose);
            res.off?.('error', onError);
        }
    };
}
