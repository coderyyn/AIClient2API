import {
    createRequestId,
    diffRuntimeMetrics,
    identifyImage,
    parseDockerStats,
    parseLevels,
    parseMemInfo,
    parseWindowsMemory,
    shouldStopAfterStage,
    summarizeSamples
} from '../scripts/runtime/runtime-load-test.js';

describe('runtime load test helpers', () => {
    test('summarizes latency percentiles and throughput', () => {
        const report = summarizeSamples([
            { ok: true, status: 200, firstByteMs: 10, totalMs: 100 },
            { ok: true, status: 200, firstByteMs: 20, totalMs: 200 },
            { ok: false, status: 429, firstByteMs: 30, totalMs: 300 }
        ], 600);

        expect(report).toMatchObject({
            requests: 3,
            successes: 2,
            errors: 1,
            errorRate: 1 / 3,
            throughput: 5,
            statuses: { 200: 2, 429: 1 }
        });
        expect(report.firstByte).toEqual({ p50: 20, p95: 30, p99: 30, max: 30 });
        expect(report.latency).toEqual({ p50: 200, p95: 300, p99: 300, max: 300 });
    });

    test('recognizes a valid PNG and rejects invalid base64 data', () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nxsAAAAASUVORK5CYII=',
            'base64'
        );

        expect(identifyImage(png)).toEqual({ mime: 'image/png', width: 1, height: 1 });
        expect(() => identifyImage(Buffer.from('not-an-image'))).toThrow(/image/i);
    });

    test('parses strictly increasing positive concurrency levels', () => {
        expect(parseLevels('1,10,25,50')).toEqual([1, 10, 25, 50]);
        expect(() => parseLevels('1,10,10')).toThrow(/increasing/i);
        expect(() => parseLevels('1,0,10')).toThrow(/positive/i);
    });

    test('parses Docker resource samples and Linux available memory', () => {
        expect(parseDockerStats('37.50%|768MiB / 2GiB')).toEqual({
            cpuPercent: 37.5,
            memoryBytes: 768 * 1024 ** 2,
            memoryLimitBytes: 2 * 1024 ** 3,
            memoryRatio: 0.375
        });
        expect(parseMemInfo('MemTotal: 8388608 kB\nMemAvailable: 1572864 kB\n')).toEqual({
            totalBytes: 8388608 * 1024,
            availableBytes: 1572864 * 1024
        });
        expect(parseWindowsMemory('{"TotalVisibleMemorySize":8388608,"FreePhysicalMemory":1572864}')).toEqual({
            totalBytes: 8388608 * 1024,
            availableBytes: 1572864 * 1024
        });
    });

    test('creates unique request ids with a stable run prefix', () => {
        const first = createRequestId('prod-old-text', 7);
        const second = createRequestId('prod-old-text', 8);

        expect(first).toMatch(/^runtime-prod-old-text-7-[a-f0-9-]+$/);
        expect(second).toMatch(/^runtime-prod-old-text-8-[a-f0-9-]+$/);
        expect(first).not.toBe(second);
    });

    test('diffs runtime metrics around a load stage', () => {
        const before = {
            requests: { total: 10, success: 9, failed: 1, byWorker: { 'execution-1': 4, 'execution-2': 6 }, byKind: { model: 10 } },
            output: { bytes: 1000, backpressureMs: 20 }
        };
        const after = {
            requests: { total: 15, success: 14, failed: 1, byWorker: { 'execution-1': 7, 'execution-2': 8 }, byKind: { model: 13, image: 2 } },
            output: { bytes: 1800, backpressureMs: 25 },
            process: { eventLoopDelay: { p95: 15, p99: 22, max: 30 }, maxEventLoopUtilization: 0.4 }
        };

        expect(diffRuntimeMetrics(before, after)).toEqual({
            requests: { total: 5, success: 5, failed: 0, byWorker: { 'execution-1': 3, 'execution-2': 2 }, byKind: { model: 3, image: 2 } },
            output: { bytes: 800, backpressureMs: 5 },
            process: { eventLoopDelay: { p95: 15, p99: 22, max: 30 }, maxEventLoopUtilization: 0.4 }
        });
    });

    test('stops after data corruption, repeated 429, resource pressure, or latency collapse', () => {
        const healthy = { firstByte: { p95: 100 }, statuses: { 200: 10 }, invalidImages: 0 };

        expect(shouldStopAfterStage(healthy, null, {})).toEqual([]);
        expect(shouldStopAfterStage(
            { ...healthy, invalidImages: 1 },
            null,
            {}
        )).toContain('invalid image response detected');
        expect(shouldStopAfterStage(
            { ...healthy, statuses: { 200: 8, 429: 2 } },
            { ...healthy, statuses: { 200: 9, 429: 1 } },
            {}
        )).toContain('429 responses persisted across consecutive stages');
        expect(shouldStopAfterStage(
            { ...healthy, firstByte: { p95: 151 } },
            healthy,
            {}
        )).toContain('first-byte p95 regressed by more than 50%');
        expect(shouldStopAfterStage(healthy, null, {
            maxMemoryRatio: 0.86,
            minHostAvailableBytes: 900 * 1024 * 1024
        })).toEqual(expect.arrayContaining([
            'container memory exceeded 85%',
            'host available memory fell below 1 GiB'
        ]));
        expect(shouldStopAfterStage(
            { ...healthy, statuses: { 200: 998, 500: 2 } },
            null,
            {}
        )).toContain('5xx rate exceeded 0.1%');
    });
});
