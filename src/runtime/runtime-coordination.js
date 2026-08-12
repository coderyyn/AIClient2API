import { RedisRespClient } from './redis-resp-client.js';
import { RedisLeaseCoordinator } from './redis-lease-coordinator.js';

export function createRuntimeCoordination({ env = process.env } = {}) {
    const role = env.RUNTIME_WORKER_ROLE;
    const enabledRole = role === 'execution'
        || (role === 'control' && env.RUNTIME_MULTI_WORKER_ENABLED === 'true');
    if (!enabledRole) return null;
    if (!env.REDIS_URL) throw new Error('REDIS_URL is required for coordinated workers');
    const url = new URL(env.REDIS_URL);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error(`Unsupported Redis protocol: ${url.protocol}`);
    const redis = new RedisRespClient({
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
        password: url.password ? decodeURIComponent(url.password) : null,
        database: Number(url.pathname.replace(/^\//, '') || 0),
        tls: url.protocol === 'rediss:'
    });
    return new RedisLeaseCoordinator({
        redis,
        epoch: env.RUNTIME_DEPLOYMENT_EPOCH || 'default',
        workerId: env.RUNTIME_WORKER_ID || `execution-${process.pid}`,
        leaseTtlMs: Number(env.RUNTIME_LEASE_TTL_MS || 120000),
        expectedWorkers: role === 'execution' ? Number(env.RUNTIME_EXECUTION_WORKERS || 1) : 1
    });
}
