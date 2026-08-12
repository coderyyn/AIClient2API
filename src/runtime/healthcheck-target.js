export function resolveHealthcheckTarget(env = process.env) {
    const multiWorkerEnabled = env.RUNTIME_MULTI_WORKER_ENABLED === 'true';

    return {
        host: env.HEALTHCHECK_HOST || '127.0.0.1',
        port: Number(env.HEALTHCHECK_PORT || (multiWorkerEnabled ? 3000 : 3100)),
        path: env.HEALTHCHECK_PATH || (multiWorkerEnabled ? '/runtime/health' : '/master/health')
    };
}
