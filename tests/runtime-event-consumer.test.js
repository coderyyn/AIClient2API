import { RuntimeEventConsumer } from '../src/runtime/runtime-event-consumer.js';

test('acknowledges only after successful application and deduplicates event ids', async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    const ack = jest.fn();
    const consumer = new RuntimeEventConsumer({ apply, ack });
    const event = { eventId: 'evt-1', sourceWorkerId: 'execution-1' };
    await consumer.consume(event);
    await consumer.consume(event);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
});

test('does not acknowledge a failed persistence event', async () => {
    const ack = jest.fn();
    const consumer = new RuntimeEventConsumer({ apply: () => Promise.reject(new Error('write failed')), ack });
    await expect(consumer.consume({ eventId: 'evt-2' })).rejects.toThrow('write failed');
    expect(ack).not.toHaveBeenCalled();
});

test('serializes hook application in receive order', async () => {
    const releaseFirst = {};
    releaseFirst.promise = new Promise(resolve => { releaseFirst.resolve = resolve; });
    const applied = [];
    const consumer = new RuntimeEventConsumer({
        apply: async event => {
            applied.push(`start:${event.eventId}`);
            if (event.eventId === 'evt-first') await releaseFirst.promise;
            applied.push(`end:${event.eventId}`);
        },
        ack: jest.fn()
    });

    const first = consumer.consume({ eventId: 'evt-first', sourceWorkerId: 'execution-1' });
    const second = consumer.consume({ eventId: 'evt-second', sourceWorkerId: 'execution-1' });
    await Promise.resolve();

    expect(applied).toEqual(['start:evt-first']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(applied).toEqual([
        'start:evt-first',
        'end:evt-first',
        'start:evt-second',
        'end:evt-second'
    ]);
});
