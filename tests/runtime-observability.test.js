import {
    createCredentialManifest,
    fingerprintCredentialManifest
} from '../src/runtime/credential-manifest.js';
import { RuntimeMetrics } from '../src/runtime/runtime-metrics.js';
import { Readable } from 'stream';
import requestContext from '../src/utils/context.js';
import { getRequestBody } from '../src/utils/common.js';

describe('runtime observability baseline', () => {
    test('credential manifest excludes secrets while preserving scheduling inputs', () => {
        const pools = {
            'gemini-antigravity': [{
                uuid: 'ag-1',
                isDisabled: false,
                supportedModels: ['gemini-3.1-flash-image'],
                concurrencyLimit: 3,
                queueLimit: 2,
                accessToken: 'secret-token',
                refreshToken: 'secret-refresh',
                proxy: 'socks5://user:pass@example.test:1080'
            }]
        };

        const manifest = createCredentialManifest(pools);

        expect(manifest).toEqual([{
            providerType: 'gemini-antigravity',
            uuid: 'ag-1',
            enabled: true,
            supportedModels: ['gemini-3.1-flash-image'],
            notSupportedModels: [],
            concurrencyLimit: 3,
            queueLimit: 2,
            weight: 1
        }]);
        expect(JSON.stringify(manifest)).not.toMatch(/secret|proxy|pass/i);
        expect(fingerprintCredentialManifest(manifest)).toMatch(/^[a-f0-9]{64}$/);
    });

    test('manifest fingerprint is stable across provider and model ordering', () => {
        const first = createCredentialManifest({
            b: [{ uuid: '2', supportedModels: ['z', 'a'] }],
            a: [{ uuid: '1' }]
        });
        const second = createCredentialManifest({
            a: [{ uuid: '1' }],
            b: [{ uuid: '2', supportedModels: ['a', 'z'] }]
        });

        expect(fingerprintCredentialManifest(first)).toBe(fingerprintCredentialManifest(second));
    });

    test('runtime metrics report request stages and process pressure without payloads', () => {
        let now = 100;
        const metrics = new RuntimeMetrics({
            now: () => now,
            sampleProcess: () => ({ rss: 1000, heapUsed: 500, eventLoopUtilization: 0.25 })
        });
        const request = metrics.beginRequest({ workerId: 'execution-1', kind: 'image' });
        now = 112;
        request.mark('bodyParsed');
        now = 127;
        request.mark('leaseAcquired');
        now = 160;
        request.mark('firstByte');
        request.addOutputBytes(4096);
        request.addBackpressureMs(7);
        now = 190;
        request.end({ statusCode: 200 });

        const snapshot = metrics.snapshot();
        expect(snapshot.requests.total).toBe(1);
        expect(snapshot.requests.byWorker['execution-1']).toBe(1);
        expect(snapshot.requests.byKind.image).toBe(1);
        expect(snapshot.stages.bodyParsed.p95).toBe(12);
        expect(snapshot.stages.leaseAcquired.p95).toBe(27);
        expect(snapshot.stages.firstByte.p95).toBe(60);
        expect(snapshot.output.bytes).toBe(4096);
        expect(snapshot.output.backpressureMs).toBe(7);
        expect(snapshot.process.rss).toBe(1000);
        expect(JSON.stringify(snapshot)).not.toContain('requestBody');
    });

    test('request body parsing marks the active runtime request without retaining the body', async () => {
        const marks = [];
        const body = JSON.stringify({ ok: true });
        const req = Readable.from([Buffer.from(body)]);
        req.headers = { 'content-length': String(Buffer.byteLength(body)) };
        const parsed = requestContext.run({ runtimeRequest: { mark: name => marks.push(name) } }, async () => {
            const promise = getRequestBody(req, { maxBytes: 1024 });
            return promise;
        });

        await expect(parsed).resolves.toEqual({ ok: true });
        expect(marks).toContain('bodyParsed');
    });
});
