import requestContext from '../src/utils/context.js';
import { closeProviderLeaseScope } from '../src/runtime/provider-lease-scope.js';
import { acquireWithProviderQueue } from '../src/runtime/provider-concurrency-queue.js';
import { applyNewProviderConcurrencyDefaults } from '../src/utils/provider-concurrency-defaults.js';
import { createProviderConfig } from '../src/utils/provider-utils.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidate = (uuid = 'a', extra = {}) => ({ providerType: 'gemini-antigravity', uuid, concurrencyLimit: 1, queueLimit: 1, ...extra });

function fixture() {
    const active = new Map();
    const queued = new Map();
    const leases = new Map();
    let sequence = 0;
    const coordinator = {
        acquire: jest.fn(async candidates => {
            const c = candidates.find(c => (active.get(c.uuid) || 0) < c.concurrencyLimit);
            if (!c) throw Object.assign(new Error('busy'), { code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
            const lease = { leaseId: `active-${++sequence}`, uuid: c.uuid, providerType: c.providerType };
            leases.set(lease.leaseId, c.uuid); active.set(c.uuid, (active.get(c.uuid) || 0) + 1);
            return lease;
        }),
        release: jest.fn(async id => { const uuid = leases.get(id); if (uuid) active.set(uuid, active.get(uuid) - 1); leases.delete(id); }),
        acquireGeminiQueueSlot: jest.fn(async ({ queueKey, perKeyLimit }) => {
            if ([...queued.values()].filter(key => key === queueKey).length >= perKeyLimit) return null;
            const leaseId = `waiting-${++sequence}`; queued.set(leaseId, queueKey); return { leaseId };
        }),
        releaseGeminiQueueSlot: jest.fn(async id => queued.delete(id))
    };
    const acquire = (candidates, options = {}, store = {}) => requestContext.run(store,
        () => acquireWithProviderQueue(coordinator, candidates, { requestedModel: 'model' }, { pollMs: 5, queueTimeout: 200, ...options }));
    return { coordinator, acquire, active, queued, leases };
}

describe('AGY new credential defaults', () => {
    test('defaults to 15/15, preserving explicit zero and unrelated providers', () => {
        expect(applyNewProviderConcurrencyDefaults('gemini-antigravity', {})).toEqual({ concurrencyLimit: 15, queueLimit: 15 });
        expect(applyNewProviderConcurrencyDefaults('gemini-antigravity', { concurrencyLimit: 0, queueLimit: 3 }))
            .toEqual({ concurrencyLimit: 0, queueLimit: 3 });
        expect(applyNewProviderConcurrencyDefaults('openai-codex-oauth', {})).toEqual({});
    });
    test('OAuth and file scanning factory supplies AGY defaults only', () => {
        expect(createProviderConfig({ credPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', credPath: 'fixture' }))
            .toMatchObject({ concurrencyLimit: 15, queueLimit: 15 });
        expect(createProviderConfig({ credPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH', credPath: 'fixture' }).queueLimit).toBeUndefined();
    });
});

describe('bounded provider queue', () => {
    test('uses another free account before reserving waiting capacity', async () => {
        const { acquire, coordinator } = fixture();
        const a = await acquire([candidate()]);
        const b = await acquire([candidate(), candidate('b')]);
        expect(b.uuid).toBe('b');
        expect(coordinator.acquireGeminiQueueSlot).not.toHaveBeenCalled();
        await coordinator.release(a.leaseId); await coordinator.release(b.leaseId);
    });
    test('bounds waiting slots and releases waiting reservation after promotion', async () => {
        const { acquire, coordinator, queued } = fixture();
        const active = await acquire([candidate()]);
        const waiting = acquire([candidate()]);
        await sleep(10);
        await expect(acquire([candidate()])).rejects.toMatchObject({ status: 429 });
        expect(queued.size).toBe(1);
        await coordinator.release(active.leaseId);
        const next = await waiting;
        expect(queued.size).toBe(0);
        await coordinator.release(next.leaseId);
    });
    test.each([{ queueLimit: 0 }, { providerType: 'openai-codex-oauth' }])('does not queue unsupported policy %j', async extra => {
        const { acquire, coordinator } = fixture();
        const active = await acquire([candidate('a', extra)]);
        await expect(acquire([candidate('a', extra)])).rejects.toMatchObject({ code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
        expect(coordinator.acquireGeminiQueueSlot).not.toHaveBeenCalled();
        await coordinator.release(active.leaseId);
    });
    test('times out and releases the distributed reservation', async () => {
        const { acquire, coordinator, queued } = fixture();
        const active = await acquire([candidate()]);
        await expect(acquire([candidate()], { queueTimeout: 15 })).rejects.toMatchObject({ status: 429 });
        expect(queued.size).toBe(0);
        await coordinator.release(active.leaseId);
    });
    test('disconnect while waiting releases queue capacity', async () => {
        const { acquire, coordinator, queued } = fixture();
        const active = await acquire([candidate()]);
        const store = {};
        const waiting = acquire([candidate()], {}, store);
        const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        await sleep(10);
        await closeProviderLeaseScope(store, 'response_close');
        await rejected;
        expect(queued.size).toBe(0);
        await coordinator.release(active.leaseId);
    });
    test('rechecks credential eligibility before promotion', async () => {
        const { acquire, coordinator, queued } = fixture();
        const active = await acquire([candidate()]);
        const isEligible = jest.fn(async () => false);
        await expect(acquire([candidate()], { isEligible })).resolves.toBeNull();
        expect(queued.size).toBe(0);
        await coordinator.release(active.leaseId);
    });
    test('queue cleanup failure does not lose the acquired provider lease', async () => {
        const { acquire, coordinator } = fixture();
        const active = await acquire([candidate()]);
        coordinator.releaseGeminiQueueSlot.mockRejectedValueOnce(new Error('offline'));
        const waiting = acquire([candidate()]);
        await sleep(10); await coordinator.release(active.leaseId);
        const next = await waiting;
        expect(next.uuid).toBe('a'); await coordinator.release(next.leaseId);
    });
    test('one poller per credential does not multiply Redis calls by waiter count', async () => {
        const { acquire, coordinator } = fixture();
        const active = await acquire([candidate()]);
        const stores = Array.from({ length: 10 }, () => ({}));
        const pending = stores.map(store => acquire([candidate('a', { queueLimit: 15 })], {}, store));
        const settled = Promise.allSettled(pending);
        await sleep(30);
        expect(coordinator.acquire.mock.calls.length).toBeLessThan(25);
        await Promise.all(stores.map(store => closeProviderLeaseScope(store, 'response_close')));
        await settled; await coordinator.release(active.leaseId);
    });
    test('rejects old waiting reservations after Redis recovery instead of exceeding the queue bound', async () => {
        const { acquire, coordinator, queued } = fixture();
        coordinator.bootId = 'before';
        const active = await acquire([candidate()]);
        const waiting = acquire([candidate()]);
        const rejected = expect(waiting).rejects.toMatchObject({ status: 503, code: 'COORDINATION_UNAVAILABLE' });
        await sleep(10);
        coordinator.bootId = 'after';
        await rejected;
        expect(queued.size).toBe(0);
        await coordinator.release(active.leaseId);
    });
});
