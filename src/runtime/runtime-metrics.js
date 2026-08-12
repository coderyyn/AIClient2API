import { performance } from 'perf_hooks';

function percentile(values, percentage) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(sorted.length * percentage / 100) - 1);
    return sorted[index];
}

function summarize(values) {
    return {
        count: values.length,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        max: values.length ? Math.max(...values) : 0
    };
}

export class RuntimeMetrics {
    constructor(options = {}) {
        this.now = options.now || (() => performance.now());
        this.sampleProcess = options.sampleProcess || (() => {
            const memory = process.memoryUsage();
            return {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                eventLoopUtilization: performance.eventLoopUtilization().utilization
            };
        });
        this.stageSamples = new Map();
        this.requests = { total: 0, success: 0, failed: 0, byWorker: {}, byKind: {} };
        this.output = { bytes: 0, backpressureMs: 0 };
        this.inFlight = 0;
    }

    beginRequest({ workerId = 'standalone', kind = 'model' } = {}) {
        const startedAt = this.now();
        let ended = false;
        this.inFlight++;
        const recordStage = (name, elapsed) => {
            const samples = this.stageSamples.get(name) || [];
            samples.push(elapsed);
            this.stageSamples.set(name, samples);
        };
        return {
            mark: name => recordStage(name, this.now() - startedAt),
            addOutputBytes: bytes => { this.output.bytes += Math.max(0, Number(bytes) || 0); },
            addBackpressureMs: ms => { this.output.backpressureMs += Math.max(0, Number(ms) || 0); },
            end: ({ statusCode = 200 } = {}) => {
                if (ended) return;
                ended = true;
                this.inFlight--;
                this.requests.total++;
                if (statusCode >= 500) this.requests.failed++;
                else this.requests.success++;
                this.requests.byWorker[workerId] = (this.requests.byWorker[workerId] || 0) + 1;
                this.requests.byKind[kind] = (this.requests.byKind[kind] || 0) + 1;
                recordStage('complete', this.now() - startedAt);
            }
        };
    }

    snapshot() {
        const stages = {};
        for (const [name, samples] of this.stageSamples.entries()) stages[name] = summarize(samples);
        return {
            requests: structuredClone(this.requests),
            stages,
            output: { ...this.output },
            inFlight: this.inFlight,
            process: this.sampleProcess()
        };
    }
}

export const runtimeMetrics = new RuntimeMetrics();

