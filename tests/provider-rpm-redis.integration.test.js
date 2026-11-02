import { createHash, randomUUID } from 'node:crypto';
import { RedisRespClient } from '../src/runtime/redis-resp-client.js';
import { RedisLeaseCoordinator } from '../src/runtime/redis-lease-coordinator.js';
import { providerRpmState } from '../src/runtime/provider-rpm.js';

const suite = process.env.RPM_TEST_REDIS_PORT ? describe : describe.skip;
suite('provider RPM against isolated real Redis', () => {
    let clients, coordinators, namespace, root, hash, windowKey;
    const type = 'openai-codex-oauth';
    beforeEach(async () => {
        const epoch = `rpm-test-${randomUUID()}`;
        clients = Array.from({ length: 4 }, () => new RedisRespClient({ port: Number(process.env.RPM_TEST_REDIS_PORT) }));
        coordinators = clients.map((redis, index) => new RedisLeaseCoordinator({ redis, epoch, workerId: `test-${index}` }));
        namespace = coordinators[0].namespace;
        root = `${namespace}:provider-rpm:`;
        hash = createHash('sha256').update(`${type}:a`).digest('hex');
        windowKey = `${root}${hash}:window`;
        await clients[0].command(['SET', `${root}epoch`, '0']);
    });
    afterEach(async () => {
        for (const coordinator of coordinators) for (const timer of coordinator.renewTimers.values()) clearInterval(timer);
        const keys = await clients[0].command(['KEYS', `${namespace}:*`]);
        if (keys.length) await clients[0].command(['DEL', ...keys]);
        await Promise.all(clients.map(client => client.close()));
    });
    const state = (limit = 10, consume = true, worker = 0, uuid = 'a') => providerRpmState(coordinators[worker], type, uuid, limit, consume);

    test('four workers and 300 concurrent attempts cannot exceed 180; peeks do not consume', async () => {
        await Promise.all(Array.from({ length: 20 }, () => state(180, false)));
        const results = await Promise.all(Array.from({ length: 300 }, (_, i) => state(180, true, i % 4)));
        expect(results.filter(result => result.allowed)).toHaveLength(180);
        expect(await state(180, false)).toMatchObject({ used: 180, allowed: false });
        expect((await state(180, true, 0, 'b')).allowed).toBe(true);
        expect(Number(await clients[0].command(['PTTL', windowKey]))).toBeGreaterThan(60000);
    });
    test('expired window frees capacity, lowering the limit retains previous sends', async () => {
        await Promise.all(Array.from({ length: 5 }, () => state(5)));
        expect(await state(2, false)).toMatchObject({ allowed: false, used: 5 });
        await clients[0].command(['EVAL', `local t=redis.call('TIME'); local n=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); for _,m in ipairs(redis.call('ZRANGE',KEYS[1],0,-1)) do redis.call('ZADD',KEYS[1],n-60000,m) end; return 1`, 1, windowKey]);
        expect(await state(2)).toMatchObject({ allowed: true, used: 1 });
    });
    test('new worker preserves counts; loss of recent window data enforces recovery window', async () => {
        await state(1);
        const restarted = new RedisLeaseCoordinator({ redis: clients[1], epoch: namespace.slice('aiclient2api:'.length) });
        expect(await providerRpmState(restarted, type, 'a', 1, false)).toMatchObject({ allowed: false, used: 1 });
        await clients[0].command(['DEL', windowKey]);
        const result = await state(1);
        expect(result).toMatchObject({ allowed: false, recovering: true });
        expect(result.retryAfterMs).toBeGreaterThan(59000);
    });
    test('cold or lost namespace waits a full window and recovers', async () => {
        await clients[0].command(['DEL', `${root}epoch`]);
        const first = await state(10);
        expect(first).toMatchObject({ allowed: false, used: 0, recovering: true });
        expect(first.retryAfterMs).toBe(60000);
        await clients[0].command(['SET', `${root}epoch`, '0']);
        expect((await state()).allowed).toBe(true);
    });
    test('selection skips exhausted sticky candidate without consuming another permit', async () => {
        await state(1);
        const coordinator = coordinators[0];
        const candidates = [{ providerType: type, uuid: 'a', rpmLimit: 1 }, { providerType: type, uuid: 'b', rpmLimit: 1 }];
        const lease = await coordinator.acquire(candidates, { routedProviderKey: `${type}:a` });
        expect(lease.uuid).toBe('b');
        expect((await state(1, false, 0, 'b')).used).toBe(0);
        await coordinator.release(lease.leaseId);
        await expect(coordinator.acquire([candidates[0]])).rejects.toMatchObject({ code: 'PROVIDER_RPM_LIMIT_EXCEEDED', status: 429 });
    });
});
