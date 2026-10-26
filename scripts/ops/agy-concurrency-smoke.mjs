// Synthetic Redis-only smoke; no model requests, credentials or production writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RedisRespClient } from '../../src/runtime/redis-resp-client.js';
import { RedisLeaseCoordinator } from '../../src/runtime/redis-lease-coordinator.js';
import { acquireWithProviderQueue } from '../../src/runtime/provider-concurrency-queue.js';
import requestContext from '../../src/utils/context.js';

const redis = new RedisRespClient({ host: '127.0.0.1', port: 6379 });
const epoch = `agy-smoke-${randomUUID()}`;
const first = new RedisLeaseCoordinator({ redis, epoch, workerId: 'smoke-1' });
const second = new RedisLeaseCoordinator({ redis, epoch, workerId: 'smoke-2' });
const candidates = [{ providerType: 'gemini-antigravity', uuid: 'synthetic-account', concurrencyLimit: 15, queueLimit: 15 }];
const active = [], promoted = [], pending = [];
try {
    for (let i = 0; i < 15; i++) active.push(await first.acquire(candidates, { requestedModel: 'synthetic-model-a' }));
    for (let i = 0; i < 15; i++) {
        const owner = i % 2 ? first : second;
        pending.push(requestContext.run({ requestId: `synthetic-${i}` }, () => acquireWithProviderQueue(owner, candidates,
            { requestedModel: i % 2 ? 'synthetic-model-a' : 'synthetic-model-b' }, { pollMs: 10, queueTimeout: 2000 })
            .then(lease => { promoted.push([owner, lease]); return lease; })));
    }
    const settled = Promise.allSettled(pending);
    // Check Redis admission itself; all queue registrations must have completed.
    let waiting = 0;
    for (let i = 0; i < 100; i++) {
        waiting = Number(await redis.command(['ZCARD', `${first.namespace}:gemini-queue:expiry`]));
        if (waiting === 15) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 15);
    await assert.rejects(acquireWithProviderQueue(second, candidates, { requestedModel: 'synthetic-model-c' }),
        error => error.code === 'PROVIDER_CONCURRENCY_EXHAUSTED');
    await Promise.all(active.splice(0).map(lease => first.release(lease.leaseId)));
    const results = await settled;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 15);
    assert.equal(Number(await redis.command(['ZCARD', `${first.namespace}:gemini-queue:expiry`])), 0);
    assert.equal(first.activeLeases.size + second.activeLeases.size, 15);
    console.log(JSON.stringify({ status: 'passed', backend: 'real Redis Lua', workers: 2, activeLimit: 15,
        queueLimit: 15, overflowRejected: true, promoted: 15, paidRequests: 0 }));
} finally {
    await Promise.allSettled(pending);
    await Promise.all(active.map(lease => first.release(lease.leaseId)));
    await Promise.all(promoted.map(([owner, lease]) => owner.release(lease.leaseId)));
    let cursor = '0';
    const ownedKeys = [];
    do {
        const [next, keys] = await redis.command(['SCAN', cursor, 'MATCH', `${first.namespace}:*`, 'COUNT', 1000]);
        cursor = String(next); ownedKeys.push(...keys);
    } while (cursor !== '0');
    assert.ok(ownedKeys.every(key => key.startsWith(`${first.namespace}:`)));
    if (ownedKeys.length) await redis.command(['DEL', ...ownedKeys]);
    await redis.close();
}
