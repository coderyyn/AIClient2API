import { RedisLeaseCoordinator, CoordinationUnavailableError } from '../src/runtime/redis-lease-coordinator.js';

class InMemoryRedisExecutor {
    constructor() {
        this.active = new Map();
        this.leases = new Map();
        this.available = true;
        this.refreshLocks = new Map();
        this.fences = new Map();
        this.bootId = 'boot-1';
        this.readyWorkers = new Set();
    }

    async evalScript(name, _script, keys, args) {
        if (!this.available) throw new Error('redis unavailable');
        if (name === 'acquire-provider-lease') {
            const [epoch, leaseId, ttlMs, workerId, candidatesJson, _nowMs, observedBootId] = args;
            if (observedBootId !== this.bootId) return JSON.stringify({ coordinationRestarted: true, bootId: this.bootId });
            const candidates = JSON.parse(candidatesJson);
            const selected = candidates
                .filter(candidate => candidate.concurrencyLimit <= 0 || (this.active.get(candidate.key) || 0) < candidate.concurrencyLimit)
                .sort((a, b) => {
                    const preferredDiff = Number(b.preferred === true) - Number(a.preferred === true);
                    if (preferredDiff !== 0) return preferredDiff;
                    const activeDiff = (this.active.get(a.key) || 0) - (this.active.get(b.key) || 0);
                    if (activeDiff !== 0) return activeDiff;
                    return Number(a.priority || 0) - Number(b.priority || 0);
                })[0];
            if (!selected) return null;
            this.active.set(selected.key, (this.active.get(selected.key) || 0) + 1);
            this.leases.set(leaseId, { epoch, providerKey: selected.key, workerId, ttlMs: Number(ttlMs) });
            return JSON.stringify({ leaseId, providerType: selected.providerType, uuid: selected.uuid });
        }
        if (name === 'recover-worker-leases') {
            const [workerId, expectedWorkers, observedBootId, _leaseTtlMs, proposedBootId, leasesJson] = args;
            if (!this.bootId) this.bootId = proposedBootId;
            for (const lease of JSON.parse(leasesJson)) {
                this.leases.set(lease.leaseId, lease);
            }
            this.readyWorkers.add(workerId);
            return JSON.stringify({ bootId: this.bootId, ready: this.readyWorkers.size >= Number(expectedWorkers), readyWorkers: this.readyWorkers.size });
        }
        if (name === 'release-provider-lease') {
            const leaseId = args[0];
            const lease = this.leases.get(leaseId);
            if (!lease) return 0;
            this.leases.delete(leaseId);
            this.active.set(lease.providerKey, Math.max(0, (this.active.get(lease.providerKey) || 0) - 1));
            return 1;
        }
        if (name === 'renew-provider-lease') return this.leases.has(args[0]) ? 1 : 0;
        if (name === 'renew-refresh-fence') {
            const lock = this.refreshLocks.get(args[0]);
            return lock && lock.owner === args[1] && String(lock.fence) === String(args[2]) ? 1 : 0;
        }
        if (name === 'acquire-refresh-fence') {
            const providerKey = args[0];
            if (this.refreshLocks.has(providerKey)) return null;
            const fence = (this.fences.get(providerKey) || 0) + 1;
            this.fences.set(providerKey, fence);
            this.refreshLocks.set(providerKey, { owner: args[1], fence });
            return fence;
        }
        if (name === 'release-refresh-fence') {
            const lock = this.refreshLocks.get(args[0]);
            if (!lock || lock.owner !== args[1] || String(lock.fence) !== String(args[2])) return 0;
            this.refreshLocks.delete(args[0]);
            return 1;
        }
        if (name === 'validate-refresh-fence') return Number(this.fences.get(args[0]) || 0) === Number(args[1]) ? 1 : 0;
        throw new Error(`unknown script ${name}`);
    }
}

describe('RedisLeaseCoordinator', () => {
    test('enforces explicit limits globally while keeping zero as unlimited', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });
        const limited = [{ providerType: 'p', uuid: 'limited', concurrencyLimit: 1 }];

        const lease = await first.acquire(limited);
        await expect(second.acquire(limited)).resolves.toBeNull();
        await first.release(lease.leaseId);
        await expect(second.acquire(limited)).resolves.toMatchObject({ uuid: 'limited' });

        const unlimited = [{ providerType: 'p', uuid: 'unlimited', concurrencyLimit: 0 }];
        const leases = await Promise.all(Array.from({ length: 20 }, () => first.acquire(unlimited)));
        expect(leases.every(Boolean)).toBe(true);
    });

    test('orders coordinated candidates by active load before local priority', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const candidates = [
            { providerType: 'p', uuid: 'first', concurrencyLimit: 0 },
            { providerType: 'p', uuid: 'second', concurrencyLimit: 0 }
        ];

        const firstLease = await coordinator.acquire(candidates);
        expect(firstLease.uuid).toBe('first');

        const secondLease = await coordinator.acquire(candidates);
        expect(secondLease.uuid).toBe('second');
    });

    test('keeps the preferred affinity provider until its explicit concurrency limit is reached', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const candidates = [
            { providerType: 'p', uuid: 'affinity', concurrencyLimit: 2, preferred: true },
            { providerType: 'p', uuid: 'fallback', concurrencyLimit: 0 }
        ];

        const first = await coordinator.acquire(candidates);
        const second = await coordinator.acquire(candidates);
        const overflow = await coordinator.acquire(candidates);

        expect(first.uuid).toBe('affinity');
        expect(second.uuid).toBe('affinity');
        expect(overflow.uuid).toBe('fallback');

        await coordinator.release(first.leaseId);
        const recovered = await coordinator.acquire(candidates);
        expect(recovered.uuid).toBe('affinity');
    });

    test('release is idempotent and never makes active counts negative', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const lease = await coordinator.acquire([{ providerType: 'p', uuid: 'one', concurrencyLimit: 1 }]);

        await expect(coordinator.release(lease.leaseId)).resolves.toBe(true);
        await expect(coordinator.release(lease.leaseId)).resolves.toBe(false);
        expect(redis.active.get('p:one')).toBe(0);
    });

    test('fails closed when Redis is unavailable', async () => {
        const redis = new InMemoryRedisExecutor();
        redis.available = false;
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });

        await expect(coordinator.acquire([{ providerType: 'p', uuid: 'one', concurrencyLimit: 0 }]))
            .rejects.toBeInstanceOf(CoordinationUnavailableError);
    });

    test('issues monotonic refresh fences and rejects stale writers', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });

        const fence1 = await first.acquireRefreshFence('provider', 'uuid');
        await expect(second.acquireRefreshFence('provider', 'uuid')).resolves.toBeNull();
        await first.releaseRefreshFence('provider', 'uuid', fence1);
        const fence2 = await second.acquireRefreshFence('provider', 'uuid');

        expect(fence2).toBeGreaterThan(fence1);
        await expect(first.validateRefreshFence('provider', 'uuid', fence1)).resolves.toBe(false);
        await expect(second.validateRefreshFence('provider', 'uuid', fence2)).resolves.toBe(true);
    });

    test('keeps a refresh lock alive during a slow OAuth refresh', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const fence = await coordinator.acquireRefreshFence('provider', 'uuid', 30);
        await expect(coordinator.renewRefreshFence('provider', 'uuid', fence, 30)).resolves.toBe(true);
    });

    test('fails closed after Redis restart until every execution worker restores its leases', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1', expectedWorkers: 2 });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2', expectedWorkers: 2 });
        await expect(first.synchronize()).resolves.toMatchObject({ ready: false });
        await expect(second.synchronize()).resolves.toMatchObject({ ready: true });
        await expect(first.synchronize()).resolves.toMatchObject({ ready: true });
        const lease = await first.acquire([{ providerType: 'p', uuid: 'one', concurrencyLimit: 1 }]);

        redis.bootId = 'boot-2';
        redis.readyWorkers.clear();
        redis.leases.clear();
        await expect(first.synchronize()).resolves.toMatchObject({ ready: false, recovering: true });
        await expect(first.acquire([{ providerType: 'p', uuid: 'two', concurrencyLimit: 1 }]))
            .rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' });
        await expect(second.synchronize()).resolves.toMatchObject({ ready: true });
        expect(redis.leases.has(lease.leaseId)).toBe(true);
    });
});
