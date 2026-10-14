import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RedisLeaseCoordinator } from '../src/runtime/redis-lease-coordinator.js';

const container = process.env.COOLDOWN_PROBE_TEST_REDIS_CONTAINER;
test('real Redis: guarded recovery, new 429 races, legacy values, shared locks and capacity', { skip: !container }, async () => {
    const command = args => JSON.parse(execFileSync('docker', ['exec', container, 'redis-cli', '--json', ...args], { encoding: 'utf8' }));
    const redis = { evalScript: async (name, script, keys, args) => command(['EVAL', script, String(keys.length), ...keys, ...args]) };
    const c = new RedisLeaseCoordinator({ redis, epoch: `cooldown-probe-test-${randomUUID()}`, workerId: 'test-worker' });
    const type = 'gemini-antigravity', uuid = 'synthetic', model = 'gemini-2.5-flash';
    const at = Date.now();
    const state = (version, healthy, time) => ({ version, updatedAt: new Date(time).toISOString(),
        isHealthy: healthy, scheduledRecoveryTime: new Date(Date.now() + 60_000).toISOString() });
    try {
        await c.setProviderModelCooldown(type, uuid, model, { version: 'v1', updatedAt: new Date(at).toISOString() });
        const first = await c.getProviderModelCooldown(type, uuid, model);
        await c.setProviderModelCooldown(type, uuid, model, { version: 'v2', updatedAt: new Date(at + 1).toISOString() });
        assert.equal(await c.compareProviderModelCooldown(type, uuid, model, first, state('r1', true, at + 2)), false);
        const second = await c.getProviderModelCooldown(type, uuid, model);
        assert.equal(await c.compareProviderModelCooldown(type, uuid, model, second, { ...state('r2', true, at + 2), supersedesVersion: 'v2' }), true);
        assert.equal((await c.getProviderModelCooldown(type, uuid, model)).value, '');
        // Delayed original publication cannot undo the recovery, even with a tied timestamp.
        assert.equal(await c.setProviderModelCooldown(type, uuid, model, { version: 'v2', updatedAt: new Date(at + 2).toISOString() }), false);
        assert.equal(await c.setProviderModelCooldown(type, uuid, model, { version: 'v3', updatedAt: new Date(at + 3).toISOString() }), true);
        const third = await c.getProviderModelCooldown(type, uuid, model);
        assert.equal(await c.compareProviderModelCooldown(type, uuid, model, third, state('v4', false, at + 4)), true);
        assert.equal(JSON.parse((await c.getProviderModelCooldown(type, uuid, model)).revision).version, 'v4');
        const lock = await c.acquireProviderModelProbe(type, uuid, model);
        assert.ok(lock);
        assert.equal(await c.acquireProviderModelProbe(type, uuid, model), null);
        assert.equal(await c.releaseProviderModelProbe(type, uuid, model, 'wrong-owner'), false);
        assert.equal(await c.releaseProviderModelProbe(type, uuid, model, lock), true);
        const candidates = [{ providerType: type, uuid, concurrencyLimit: 1 }];
        await assert.rejects(c.acquire(candidates, { requestedModel: model }), e => e.quotaScope === 'model');
        const lease = await c.acquire(candidates); // maintenance only: bypass model, retain account limit
        assert.ok(lease);
        await assert.rejects(c.acquire(candidates), e => e.code === 'PROVIDER_CONCURRENCY_EXHAUSTED');
        await c.release(lease.leaseId);
        const latest = await c.getProviderModelCooldown(type, uuid, model);
        await c.compareProviderModelCooldown(type, uuid, model, latest, state('restored', true, at + 5));
        const normal = await c.acquire(candidates, { requestedModel: model });
        assert.ok(normal); await c.release(normal.leaseId);
        // A legacy cooldown has no revision key, but still uses exact-value CAS.
        const keys = command(['KEYS', `${c.namespace}:model-cooldown:*:revision`]);
        assert.equal(keys.length, 1);
        const key = keys[0].slice(0, -':revision'.length);
        command(['DEL', keys[0]]); command(['SET', key, 'legacy', 'PX', '60000']);
        const legacy = await c.getProviderModelCooldown(type, uuid, model);
        assert.equal(legacy.revision, '');
        assert.equal(await c.compareProviderModelCooldown(type, uuid, model, legacy, state('migrated', true, at + 6)), true);
    } finally {
        for (const timer of c.renewTimers.values()) clearInterval(timer);
        const keys = command(['KEYS', `${c.namespace}:*`]);
        assert.ok(keys.every(key => key.startsWith(`${c.namespace}:`)));
        if (keys.length) command(['DEL', ...keys]);
        assert.deepEqual(command(['KEYS', `${c.namespace}:*`]), []);
    }
});
