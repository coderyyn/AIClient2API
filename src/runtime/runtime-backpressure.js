export function writeWithBackpressure(response, chunk) {
    if (!response || typeof response.write !== 'function') return Promise.resolve(false);
    const startedAt = Date.now();
    const accepted = response.write(chunk);
    if (accepted !== false || typeof response.once !== 'function') return Promise.resolve(accepted);
    return new Promise((resolve, reject) => {
        const onDrain = () => {
            response.runtimeRequest?.addBackpressureMs?.(Date.now() - startedAt);
            resolve(true);
        };
        const onError = error => reject(error);
        response.once('drain', onDrain);
        response.once?.('error', onError);
    });
}

export async function writeChunksWithBackpressure(response, chunks) {
    for (const chunk of chunks || []) await writeWithBackpressure(response, chunk);
}
