import { createHash, randomUUID } from 'node:crypto';
import { RedisRespClient } from '../src/runtime/redis-resp-client.js';
import { RedisLeaseCoordinator } from '../src/runtime/redis-lease-coordinator.js';
import { providerRpmState } from '../src/runtime/provider-rpm.js';
const suite = process.env.RPM_TEST_REDIS_PORT ? describe : describe.skip;
suite('GPT mixed routing with shared Redis', () => {
    let clients, workers, namespace;
    beforeEach(async () => {
        const epoch = 'mixed-test-' + randomUUID();
        clients = Array.from({ length: 4 }, () => new RedisRespClient({ port: Number(process.env.RPM_TEST_REDIS_PORT) }));
        workers = clients.map((redis, i) => new RedisLeaseCoordinator({ redis, epoch, workerId: 'worker-' + i }));
        namespace = workers[0].namespace;
        await Promise.all(workers.map(w => w.synchronize()));
        await clients[0].command(['SET', namespace + ':provider-rpm:epoch', '0']);
    });
    afterEach(async () => {
        for (const w of workers) for (const timer of w.renewTimers.values()) clearInterval(timer);
        const keys = await clients[0].command(['KEYS', namespace + ':*']);
        if (keys.length) await clients[0].command(['DEL', ...keys]);
        await Promise.all(clients.map(c => c.close()));
    });
    const candidate = (uuid, extra = {}) => ({ providerType: 'openaiResponses-custom', uuid, ...extra });
    test('four workers share exact equal turns across provider types regardless of node weights', async () => {
        const cs = [candidate('key-a'), candidate('key-b'), { ...candidate('codex'), providerType: 'openai-codex-oauth' }];
        const selected = await Promise.all(Array.from({ length:  90 }, (_, i) => workers[i % 4].acquire(cs, { mixedScope: 'all', requestedModel: 'gpt-6-sol' })));
        const counts = {};
        for (const lease of selected) counts[lease.uuid] = (counts[lease.uuid] || 0) + 1;
        expect(counts).toEqual({ 'key-a': 30, 'key-b': 30, codex: 30 });
    });
    test('nearest expiring Key wins, full concurrency and exhausted Codex RPM spill to other candidates', async () => {
        const now = Date.now();
        const cs = [candidate('normal', { mixedResetAt: now + 4 * 86400000 }),
            candidate('urgent', { mixedResetAt: now + 86400000, concurrencyLimit: 1 }),
            candidate('later', { mixedResetAt: now + 2 * 86400000, concurrencyLimit: 1 })];
        const first = await workers[0].acquire(cs, { mixedScope: 'priority' });
        expect(first.uuid).toBe('urgent');expect(first.mixedReason).toBe('EXPIRING_KEY');
        const second = await workers[1].acquire(cs, { mixedScope: 'priority' });expect(second.uuid).toBe('later');
        const third = await workers[2].acquire(cs, { mixedScope: 'priority' });expect(third.uuid).toBe('normal');
        const codex = { providerType: 'openai-codex-oauth', uuid: 'limited', rpmLimit: 1 };
        await providerRpmState(workers[0], codex.providerType, codex.uuid, 1, true);
        expect((await workers[3].acquire([codex, candidate('key')], { mixedScope: 'rpm' })).uuid).toBe('key');
    });
    test('72-hour boundary is strict using a controlled Redis clock', async () => {
        const clock = Date.now();const original = clients[0].evalScript.bind(clients[0]);
        clients[0].evalScript = (name, script, keys, args) => original(name, script.replace("redis.call('TIME')", `{${Math.floor(clock / 1000)},${(clock % 1000) * 1000}}`), keys, args);
        const cs = [candidate('normal'), candidate('boundary', { mixedResetAt: clock + 259200000 }), candidate('inside', { mixedResetAt: clock + 259199999 })];
        expect((await workers[0].acquire(cs, { mixedScope: 'boundary' })).uuid).toBe('inside');
        const lease = await workers[0].acquire(cs.slice(0,2), { mixedScope: 'boundary-exact' });expect(lease.mixedReason).toBe('EQUAL_SHARE');
    });

    test('same reset time shares turns and reset expiry exits the priority tier', async () => {
        const clock = Date.now();
        const original = clients[0].evalScript.bind(clients[0]);
        clients[0].evalScript = (name, script, keys, args) => original(name, script.replace("redis.call('TIME')", `{${Math.floor(clock / 1000)},${(clock % 1000) * 1000}}`), keys, args);
        const urgent = [candidate('a', { mixedResetAt: clock + 1000 }), candidate('b', { mixedResetAt: clock + 1000 }), candidate('normal')];
        const selected = [];
        for (let i = 0; i < 6; i++) selected.push((await workers[0].acquire(urgent, { mixedScope: 'same-reset' })).uuid);
        expect(selected).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
        urgent[0].mixedResetAt = clock;
        urgent[1].mixedResetAt = clock;
        expect((await workers[0].acquire(urgent, { mixedScope: 'same-reset' })).mixedReason).toBe('EQUAL_SHARE');
    });

    test('response binding survives release epochs, is scoped to the client Key and expires', async () => {
        const responseId = 'fixture-' + randomUUID();
        const keyRef = 'fixture-client';
        const bindingKey = 'aiclient2api:gpt-response:' + createHash('sha256').update(keyRef + ':' + responseId).digest('hex');
        try {
            const binding = { providerType: 'openaiResponses-custom', uuid: 'fixture-key', model: 'gpt-6-sol' };
            await workers[0].setMixedResponseBinding(keyRef, responseId, binding);
            const nextRelease = new RedisLeaseCoordinator({ redis: clients[1], epoch: 'another-release', workerId: 'another-worker' });
            expect(await nextRelease.getMixedResponseBinding(keyRef, responseId)).toEqual(binding);
            expect(await nextRelease.getMixedResponseBinding('other-client', responseId)).toBeNull();
            expect(Number(await clients[0].command(['TTL', bindingKey]))).toBeGreaterThan(2591900);
        } finally {
            await clients[0].command(['DEL', bindingKey]);
        }
    });
});
