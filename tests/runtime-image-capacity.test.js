describe('runtime image capacity signals', () => {
    test('reads event-loop pressure from the process metrics path without carrying cumulative backpressure into admission', async () => {
        const module = await import('../src/runtime/runtime-image-capacity.js');
        expect(module.buildImageCapacitySignals).toEqual(expect.any(Function));

        expect(module.buildImageCapacitySignals({
            process: {
                rss: 512,
                eventLoopDelay: { p95: 225 }
            },
            output: { backpressureMs: 10_000 },
            stages: { eventLoopDelay: { p95: 1 } }
        }, 2048)).toEqual({
            rssBytes: 512,
            rssLimitBytes: 2048,
            eventLoopP95Ms: 225
        });
    });
});
