import { BigObjectCapacity, resolveBigObjectBudget, resolveImageQueueLimit } from '../src/runtime/big-object-capacity.js';

describe('BigObjectCapacity', () => {
    test('queues image work and releases estimated bytes without imposing a fixed request cap', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 100, queueLimit: 2, waitMs: 20, metrics: { rssBytes: 0, eventLoopP95Ms: 0, backpressureMs: 0 } });
        const first = await capacity.acquire({ bytes: 80, kind: 'image' });
        const pending = capacity.acquire({ bytes: 30, kind: 'image' });
        expect(capacity.snapshot().activeBytes).toBe(80);
        capacity.release(first);
        await expect(pending).resolves.toMatchObject({ bytes: 30 });
    });

    test('rejects after the bounded wait with the stable capacity error', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 10, queueLimit: 0, waitMs: 5, metrics: {} });
        await capacity.acquire({ bytes: 10, kind: 'image' });
        await expect(capacity.acquire({ bytes: 1, kind: 'image' })).rejects.toMatchObject({ code: 'IMAGE_CAPACITY_EXCEEDED', statusCode: 429 });
    });

    test('uses 25% of a container limit and scales queue size with healthy credentials', () => {
        expect(resolveBigObjectBudget({ containerLimitBytes: 8 * 1024 ** 3 })).toBe(2 * 1024 ** 3);
        expect(resolveBigObjectBudget({ containerLimitBytes: null })).toBe(2 * 1024 ** 3);
        expect(resolveImageQueueLimit(30)).toBe(60);
        expect(resolveImageQueueLimit(80)).toBe(100);
    });

    test('accepts a production-sized 50-request image burst when byte budget allows it', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 400 * 1024 * 1024, queueLimit: 100, waitMs: 10, metrics: {} });
        const tickets = await Promise.all(Array.from({ length: 50 }, () => capacity.acquire({ bytes: 4 * 1024 * 1024, kind: 'image' })));
        expect(tickets).toHaveLength(50);
        expect(capacity.snapshot().activeBytes).toBe(200 * 1024 * 1024);
        tickets.forEach(ticket => capacity.release(ticket));
        expect(capacity.snapshot()).toMatchObject({ activeBytes: 0, queued: 0 });
    });
});
