import { compareRuntimeReports } from '../src/runtime/runtime-regression-gate.js';

describe('runtime regression gate', () => {
    test('accepts equal or better throughput with p95 within five percent and no errors', () => {
        const result = compareRuntimeReports(
            { throughput: 10, errorRate: 0, latency: { p95: 1000 } },
            { throughput: 12, errorRate: 0, latency: { p95: 1049 } }
        );
        expect(result.passed).toBe(true);
        expect(result.failures).toEqual([]);
    });

    test('rejects throughput, error-rate, or latency regressions', () => {
        const result = compareRuntimeReports(
            { throughput: 10, errorRate: 0.01, latency: { p95: 1000 } },
            { throughput: 9, errorRate: 0.02, latency: { p95: 1100 } }
        );
        expect(result.passed).toBe(false);
        expect(result.failures).toEqual(expect.arrayContaining([
            expect.stringMatching(/throughput/i),
            expect.stringMatching(/error rate/i),
            expect.stringMatching(/p95/i)
        ]));
    });
});
