import requestContext from '../utils/context.js';
import { getProviderLeaseScope } from './provider-lease-scope.js';
import logger from '../utils/logger.js';

const groupsByCoordinator = new WeakMap();
const capacityError = () => Object.assign(new Error('Provider concurrency queue is full or timed out'), {
    status: 429, statusCode: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED'
});
const abortError = () => Object.assign(new Error('Request ended while waiting for a provider slot'), {
    name: 'AbortError', status: 499
});

/** Redis bounds waiting slots across workers; one poller per worker/credential avoids waiter fanout. */
export async function acquireWithProviderQueue(coordinator, candidates, leaseOptions, {
    skipCredentialQueue = false, queueTimeout = 300000, pollMs = 200, isEligible = async () => true
} = {}) {
    try {
        return await coordinator.acquire(candidates, leaseOptions);
    } catch (error) {
        if (error.code !== 'PROVIDER_CONCURRENCY_EXHAUSTED' || skipCredentialQueue) throw error;
    }
    const store = requestContext.getStore();
    const scope = getProviderLeaseScope(store);
    if (scope.closed) throw abortError();
    const timeoutMs = Math.min(300000, Math.max(1, Number(queueTimeout) || 300000));
    let selected, reservation;
    for (const candidate of candidates) {
        if (candidate.providerType !== 'gemini-antigravity' || !(candidate.queueLimit > 0)) continue;
        const result = await coordinator.acquireGeminiQueueSlot({
            queueKey: `credential:${candidate.providerType}:${candidate.uuid}`,
            perKeyLimit: candidate.queueLimit, ttlMs: timeoutMs + 5000
        });
        if (result?.leaseId) { selected = candidate; reservation = result; break; }
    }
    if (!reservation) throw capacityError();
    const reservationBootId = coordinator.bootId;
    const reservationLost = () => Object.assign(new Error('Queue reservation invalidated by Redis recovery'), {
        status: 503, code: 'COORDINATION_UNAVAILABLE'
    });
    try {
        if (scope.closed) throw abortError();
        let groups = groupsByCoordinator.get(coordinator);
        if (!groups) { groups = new Map(); groupsByCoordinator.set(coordinator, groups); }
        const key = `${selected.providerType}:${selected.uuid}`;
        let group = groups.get(key);
        if (!group) { group = { waiting: [], running: false, timer: null }; groups.set(key, group); }
        return await new Promise((resolve, reject) => {
            const entry = { store, scope, selected, leaseOptions, isEligible, resolve, reject,
                deadline: Date.now() + timeoutMs, timer: null, settled: false };
            const finish = (item, error, lease) => {
                if (item.settled) return;
                item.settled = true;
                clearTimeout(item.timer);
                const index = group.waiting.indexOf(item);
                if (index >= 0) group.waiting.splice(index, 1);
                if (error) item.reject(error); else item.resolve(lease);
            };
            const schedule = () => {
                if (!group.waiting.length) {
                    clearTimeout(group.timer); group.timer = null; groups.delete(key); return;
                }
                if (!group.timer && !group.running) group.timer = setTimeout(pump, pollMs);
            };
            const pump = async () => {
                group.timer = null;
                if (group.running) return;
                group.running = true;
                try {
                    for (const item of [...group.waiting]) {
                        if (item.scope.closed) finish(item, abortError());
                        else if (Date.now() >= item.deadline) finish(item, capacityError());
                    }
                    while (group.waiting.length) {
                        const item = group.waiting[0];
                        try {
                            const lease = await requestContext.run(item.store, async () => {
                                if (coordinator.bootId !== reservationBootId) throw reservationLost();
                                if (!await item.isEligible(item.selected)) return null;
                                const acquired = await coordinator.acquire([item.selected], item.leaseOptions);
                                if (coordinator.bootId !== reservationBootId) {
                                    if (acquired) await coordinator.release(acquired.leaseId);
                                    throw reservationLost();
                                }
                                return acquired;
                            });
                            // A timeout/close can win while Redis is still returning an acquisition.
                            if (item.settled || item.scope.closed) {
                                if (lease) await coordinator.release(lease.leaseId);
                                if (!item.settled) finish(item, abortError());
                            } else finish(item, null, lease);
                        } catch (error) {
                            if (error.code === 'PROVIDER_CONCURRENCY_EXHAUSTED') break;
                            finish(item, error);
                        }
                    }
                } finally {
                    group.running = false;
                    schedule();
                }
            };
            entry.timer = setTimeout(() => { finish(entry, capacityError()); schedule(); }, timeoutMs);
            group.waiting.push(entry);
            schedule();
        });
    } finally {
        // Queue reservation TTL is the fallback; a release failure must not orphan an acquired provider lease.
        await coordinator.releaseGeminiQueueSlot(reservation.leaseId).catch(() => {
            logger.warn('[Provider Queue] Reservation release failed; waiting for expiry');
        });
    }
}
