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

    test('does not treat cumulative output backpressure as a permanent image admission block', async () => {
        const capacity = new BigObjectCapacity({
            budgetBytes: 100,
            queueLimit: 0,
            waitMs: 5,
            metrics: {
                rssBytes: 10,
                rssLimitBytes: 1000,
                eventLoopP95Ms: 20,
                backpressureMs: 10_000
            }
        });

        await expect(capacity.acquire({ bytes: 20, kind: 'image' })).resolves.toMatchObject({
            bytes: 20,
            kind: 'image'
        });
    });

    test('reports safe capacity diagnostics when a current pressure gate rejects work', async () => {
        const capacity = new BigObjectCapacity({
            budgetBytes: 100,
            queueLimit: 0,
            waitMs: 5,
            metrics: {
                rssBytes: 850,
                rssLimitBytes: 1000,
                eventLoopP95Ms: 250,
                backpressureMs: 99_999
            }
        });

        await expect(capacity.acquire({ bytes: 20, kind: 'image-edit' })).rejects.toMatchObject({
            code: 'IMAGE_CAPACITY_EXCEEDED',
            details: {
                blockedReasons: ['rss', 'event_loop'],
                activeBytes: 0,
                budgetBytes: 100,
                estimatedBytes: 20,
                rssBytes: 850,
                rssLimitBytes: 1000,
                eventLoopP95Ms: 250,
                queued: 0
            }
        });
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
