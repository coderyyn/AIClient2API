const MODEL_ROUTES = [
    /^\/(?:[^/]+\/)?v1\/(?:chat\/completions|responses|messages|models|images\/(?:generations|edits))$/,
    /^\/(?:[^/]+\/)?v1\/messages\/count_tokens$/,
    /^\/(?:[^/]+\/)?v1beta\/models(?:\/.*)?$/
];

export function classifyRuntimeRequest(method, rawPath) {
    const path = String(rawPath || '').split('?')[0];
    if (MODEL_ROUTES.some(pattern => pattern.test(path))) return 'execution';
    return 'control';
}

export function resolveWorkerTopology(env = process.env) {
    const parsed = Number.parseInt(env.RUNTIME_EXECUTION_WORKERS, 10);
    return {
        controlWorkers: 1,
        executionWorkers: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 32) : 3
    };
}
