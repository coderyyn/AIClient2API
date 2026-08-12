import { writeWithBackpressure } from '../src/runtime/runtime-backpressure.js';

test('waits for drain when a response applies backpressure', async () => {
    let drained = false;
    const response = { write: () => false, once: (event, cb) => { if (event === 'drain') setTimeout(() => { drained = true; cb(); }, 1); } };
    await writeWithBackpressure(response, 'chunk');
    expect(drained).toBe(true);
});
