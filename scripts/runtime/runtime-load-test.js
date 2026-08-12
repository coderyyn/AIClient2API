import fs from 'fs/promises';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

function percentile(values, ratio) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeTiming(values) {
    return {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: values.length ? Math.max(...values) : 0
    };
}

export function summarizeSamples(samples, elapsedMs) {
    const statuses = {};
    for (const sample of samples) {
        statuses[sample.status] = (statuses[sample.status] || 0) + 1;
    }
    const successes = samples.filter(sample => sample.ok).length;
    return {
        requests: samples.length,
        successes,
        errors: samples.length - successes,
        errorRate: samples.length ? (samples.length - successes) / samples.length : 0,
        throughput: elapsedMs > 0 ? samples.length / (elapsedMs / 1000) : 0,
        statuses,
        firstByte: summarizeTiming(samples.map(sample => sample.firstByteMs).filter(Number.isFinite)),
        latency: summarizeTiming(samples.map(sample => sample.totalMs).filter(Number.isFinite)),
        invalidImages: samples.filter(sample => sample.invalidImage).length,
        errorCodes: samples.reduce((result, sample) => {
            if (sample.errorCode) result[sample.errorCode] = (result[sample.errorCode] || 0) + 1;
            return result;
        }, {})
    };
}

export function createRequestId(runId, sequence) {
    const normalized = String(runId || 'run').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    return `runtime-${normalized}-${sequence}-${randomUUID()}`;
}

function diffMap(before = {}, after = {}) {
    const result = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const value = Number(after[key] || 0) - Number(before[key] || 0);
        if (value !== 0) result[key] = value;
    }
    return result;
}

export function diffRuntimeMetrics(before = {}, after = {}) {
    return {
        requests: {
            total: Number(after.requests?.total || 0) - Number(before.requests?.total || 0),
            success: Number(after.requests?.success || 0) - Number(before.requests?.success || 0),
            failed: Number(after.requests?.failed || 0) - Number(before.requests?.failed || 0),
            byWorker: diffMap(before.requests?.byWorker, after.requests?.byWorker),
            byKind: diffMap(before.requests?.byKind, after.requests?.byKind)
        },
        output: {
            bytes: Number(after.output?.bytes || 0) - Number(before.output?.bytes || 0),
            backpressureMs: Number(after.output?.backpressureMs || 0) - Number(before.output?.backpressureMs || 0)
        },
        process: {
            eventLoopDelay: { ...(after.process?.eventLoopDelay || { p95: 0, p99: 0, max: 0 }) },
            maxEventLoopUtilization: Number(after.process?.maxEventLoopUtilization || 0)
        }
    };
}

export function parseLevels(value) {
    const levels = String(value || '').split(',').map(item => Number(item.trim()));
    if (levels.some(item => !Number.isInteger(item) || item <= 0)) {
        throw new Error('concurrency levels must be positive integers');
    }
    if (levels.some((item, index) => index > 0 && item <= levels[index - 1])) {
        throw new Error('concurrency levels must be strictly increasing');
    }
    return levels;
}

function parseByteQuantity(value) {
    const match = String(value || '').trim().match(/^([0-9.]+)\s*([kmgt]?i?b)$/i);
    if (!match) return 0;
    const unit = match[2].toLowerCase();
    const powers = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 };
    return Number(match[1]) * 1024 ** powers[unit];
}

export function parseDockerStats(value) {
    const [cpuText, memoryText] = String(value || '').trim().split('|');
    const [usedText, limitText] = String(memoryText || '').split('/');
    const memoryBytes = parseByteQuantity(usedText);
    const memoryLimitBytes = parseByteQuantity(limitText);
    return {
        cpuPercent: Number(String(cpuText || '').replace('%', '')) || 0,
        memoryBytes,
        memoryLimitBytes,
        memoryRatio: memoryLimitBytes > 0 ? memoryBytes / memoryLimitBytes : 0
    };
}

export function parseMemInfo(value) {
    const fields = {};
    for (const line of String(value || '').split(/\r?\n/)) {
        const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/);
        if (match) fields[match[1]] = Number(match[2]) * 1024;
    }
    return { totalBytes: fields.MemTotal || 0, availableBytes: fields.MemAvailable || 0 };
}

export function parseWindowsMemory(value) {
    try {
        const parsed = JSON.parse(String(value || '').trim());
        return {
            totalBytes: Number(parsed.TotalVisibleMemorySize || 0) * 1024,
            availableBytes: Number(parsed.FreePhysicalMemory || 0) * 1024
        };
    } catch {
        return { totalBytes: 0, availableBytes: 0 };
    }
}

export function identifyImage(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('invalid image payload');
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) { offset++; continue; }
            const marker = buffer[offset + 1];
            const size = buffer.readUInt16BE(offset + 2);
            if (marker >= 0xc0 && marker <= 0xc3) {
                return { mime: 'image/jpeg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
            }
            if (size < 2) break;
            offset += 2 + size;
        }
    }
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return { mime: 'image/webp', width: null, height: null };
    }
    throw new Error('invalid or unsupported image payload');
}

export function shouldStopAfterStage(report, previousReport, resources = {}) {
    const reasons = [];
    if (report.invalidImages > 0) reasons.push('invalid image response detected');
    if ((report.statuses?.[429] || 0) > 0 && (previousReport?.statuses?.[429] || 0) > 0) {
        reasons.push('429 responses persisted across consecutive stages');
    }
    if (previousReport?.firstByte?.p95 > 0 && report.firstByte?.p95 > previousReport.firstByte.p95 * 1.5) {
        reasons.push('first-byte p95 regressed by more than 50%');
    }
    if (Number(resources.maxMemoryRatio) > 0.85) reasons.push('container memory exceeded 85%');
    if (Number(resources.minHostAvailableBytes) > 0 && Number(resources.minHostAvailableBytes) < 1024 ** 3) {
        reasons.push('host available memory fell below 1 GiB');
    }
    if (Number(resources.eventLoopP99Ms) > 1000 && Number(resources.eventLoopP99DurationMs) >= 30_000) {
        reasons.push('event-loop p99 exceeded 1 second for 30 seconds');
    }
    const serverErrors = Object.entries(report.statuses || {}).reduce((total, [status, count]) => total + (Number(status) >= 500 ? count : 0), 0);
    const requestCount = Number(report.requests) || Object.values(report.statuses || {}).reduce((total, count) => total + Number(count || 0), 0);
    if (requestCount > 0 && serverErrors / requestCount > 0.001) reasons.push('5xx rate exceeded 0.1%');
    if (report.errorCodes?.AUTH_ERROR >= 2) reasons.push('provider authentication errors repeated');
    return reasons;
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith('--')) continue;
        const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
        const value = inlineValue ?? (argv[index + 1]?.startsWith('--') ? true : argv[++index]);
        options[rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    return options;
}

function normalizeBaseUrl(value) {
    return String(value || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

function getErrorCode(status, body) {
    if (status === 401 || status === 403 || /auth|token|credential/i.test(body)) return 'AUTH_ERROR';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'SERVER_ERROR';
    return status >= 400 ? 'CLIENT_ERROR' : null;
}

async function readResponseBody(response, startedAt) {
    const reader = response.body?.getReader();
    if (!reader) return { firstByteMs: Date.now() - startedAt, body: Buffer.alloc(0) };
    const chunks = [];
    let firstByteMs = null;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
        chunks.push(Buffer.from(value));
    }
    return { firstByteMs: firstByteMs ?? Date.now() - startedAt, body: Buffer.concat(chunks) };
}

async function runTextRequest(options, sequence) {
    const startedAt = Date.now();
    const clientRequestId = createRequestId(options.runId, sequence);
    try {
        const response = await fetch(`${options.baseUrl}${options.textPath}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${options.apiKey}`,
                'X-Request-ID': clientRequestId,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-5.4',
                input: [{ role: 'user', content: options.textPrompt }],
                max_output_tokens: options.maxOutputTokens,
                stream: true,
                store: false
            }),
            signal: AbortSignal.timeout(options.timeoutMs)
        });
        const { firstByteMs, body } = await readResponseBody(response, startedAt);
        const text = body.toString('utf8');
        const streamComplete = !response.ok || /response\.completed|\[DONE\]/.test(text);
        return {
            ok: response.ok && streamComplete,
            status: response.status,
            firstByteMs,
            totalMs: Date.now() - startedAt,
            errorCode: response.ok && streamComplete ? null : getErrorCode(response.status, text),
            clientRequestId,
            serverRequestId: response.headers.get('x-request-id') || null
        };
    } catch (error) {
        return { ok: false, status: 0, firstByteMs: Date.now() - startedAt, totalMs: Date.now() - startedAt, errorCode: error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
    }
}

async function runImageRequest(options, sequence) {
    const startedAt = Date.now();
    const clientRequestId = createRequestId(options.runId, sequence);
    try {
        const response = await fetch(`${options.baseUrl}${options.imagePath}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${options.apiKey}`,
                'X-Request-ID': clientRequestId,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-image-2',
                prompt: options.imagePrompt,
                size: options.imageSize,
                quality: options.imageQuality,
                n: 1,
                response_format: 'b64_json'
            }),
            signal: AbortSignal.timeout(options.timeoutMs)
        });
        const { firstByteMs, body } = await readResponseBody(response, startedAt);
        const text = body.toString('utf8');
        if (!response.ok) {
            return { ok: false, status: response.status, firstByteMs, totalMs: Date.now() - startedAt, errorCode: getErrorCode(response.status, text) };
        }
        try {
            const payload = JSON.parse(text);
            const images = (payload.data || []).map(item => Buffer.from(item.b64_json || '', 'base64'));
            if (images.length !== 1) throw new Error(`expected one image, received ${images.length}`);
            const image = identifyImage(images[0]);
            return { ok: true, status: response.status, firstByteMs, totalMs: Date.now() - startedAt, image, clientRequestId, serverRequestId: response.headers.get('x-request-id') || null };
        } catch {
            return { ok: false, status: response.status, firstByteMs, totalMs: Date.now() - startedAt, invalidImage: true, errorCode: 'INVALID_IMAGE' };
        }
    } catch (error) {
        return { ok: false, status: 0, firstByteMs: Date.now() - startedAt, totalMs: Date.now() - startedAt, errorCode: error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
    }
}

async function runStage(kind, concurrency, options) {
    const startedAt = Date.now();
    const runner = kind === 'text' ? runTextRequest : runImageRequest;
    const runtimeBefore = await fetchRuntimeMetrics(options);
    const sampler = startResourceSampler(options);
    const samples = await Promise.all(Array.from({ length: concurrency }, (_, index) => runner(options, index + 1)));
    const resources = await sampler.stop();
    const runtimeAfter = await fetchRuntimeMetrics(options);
    const runtime = runtimeBefore && runtimeAfter ? diffRuntimeMetrics(runtimeBefore, runtimeAfter) : null;
    return { ...summarizeSamples(samples, Date.now() - startedAt), concurrency, resources, runtime, samples };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRuntimeMetrics(options) {
    try {
        const response = await fetch(`${options.baseUrl}/runtime/health`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        const payload = await response.json();
        return payload.metrics || null;
    } catch {
        return null;
    }
}

function runCommand(command, args) {
    return new Promise(resolve => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(stdout.trim()));
    });
}

async function sampleResources(containerName) {
    const dockerSample = containerName
        ? parseDockerStats(await runCommand('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', containerName]))
        : null;
    let hostMemory = { totalBytes: 0, availableBytes: 0 };
    if (process.platform === 'linux') {
        try { hostMemory = parseMemInfo(await fs.readFile('/proc/meminfo', 'utf8')); } catch { /* optional */ }
    } else if (process.platform === 'win32') {
        const output = await runCommand('powershell.exe', [
            '-NoLogo', '-NoProfile', '-Command',
            'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress'
        ]);
        hostMemory = parseWindowsMemory(output);
    }
    return { docker: dockerSample, hostMemory, sampledAt: new Date().toISOString() };
}

function summarizeResources(samples) {
    const docker = samples.map(sample => sample.docker).filter(Boolean);
    const available = samples.map(sample => sample.hostMemory.availableBytes).filter(value => value > 0);
    return {
        samples: samples.length,
        maxCpuPercent: docker.length ? Math.max(...docker.map(item => item.cpuPercent)) : 0,
        maxMemoryBytes: docker.length ? Math.max(...docker.map(item => item.memoryBytes)) : 0,
        maxMemoryRatio: docker.length ? Math.max(...docker.map(item => item.memoryRatio)) : 0,
        minHostAvailableBytes: available.length ? Math.min(...available) : 0
    };
}

function startResourceSampler(options) {
    const samples = [];
    let stopped = false;
    const intervalMs = Math.max(1000, Number(options.resourceSampleMs) || 5000);
    const take = async () => { samples.push(await sampleResources(options.containerName)); };
    const initial = take();
    const timer = setInterval(() => { if (!stopped) void take(); }, intervalMs);
    return {
        async stop() {
            stopped = true;
            clearInterval(timer);
            await initial;
            await take();
            return summarizeResources(samples);
        }
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const kind = args.kind || 'text';
    if (!['text', 'image'].includes(kind)) throw new Error('--kind must be text or image');
    const apiKey = process.env.RUNTIME_TEST_API_KEY;
    if (!apiKey) throw new Error('RUNTIME_TEST_API_KEY is required');
    const options = {
        apiKey,
        baseUrl: normalizeBaseUrl(args.baseUrl),
        textPath: args.textPath || '/openai-codex-oauth/v1/responses',
        imagePath: args.imagePath || '/openai-codex-oauth/v1/images/generations',
        textPrompt: args.textPrompt || 'Reply with exactly: ok',
        imagePrompt: args.imagePrompt || 'A single small green circle centered on a plain white background.',
        imageSize: args.imageSize || '1024x1024',
        imageQuality: args.imageQuality || 'low',
        maxOutputTokens: Number(args.maxOutputTokens || 16),
        timeoutMs: Number(args.timeoutMs || (kind === 'image' ? 600_000 : 180_000)),
        containerName: args.container || '',
        resourceSampleMs: Number(args.resourceSampleMs || 5000)
    };
    options.runId = args.runId || `${kind}-${Date.now()}`;
    const levels = parseLevels(args.levels || (kind === 'image' ? '1,5,10,20,30,50' : '1,10,25,50,75,100,150,200'));
    const cooldownMs = Number(args.cooldownMs || 30_000);
    const report = { version: 1, kind, startedAt: new Date().toISOString(), target: options.baseUrl, levels, stages: [], stopped: false, stopReasons: [] };
    let previous = null;
    for (const level of levels) {
        process.stderr.write(`[runtime-load-test] ${kind} concurrency=${level}\n`);
        const stage = await runStage(kind, level, options);
        report.stages.push(stage);
        const reasons = shouldStopAfterStage(stage, previous, stage.resources);
        if (reasons.length) {
            report.stopped = true;
            report.stopReasons = reasons;
            break;
        }
        previous = stage;
        if (level !== levels.at(-1) && cooldownMs > 0) await sleep(cooldownMs);
    }
    report.finishedAt = new Date().toISOString();
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) await fs.writeFile(args.output, output, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(output);
    if (report.stopped) process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(error => {
    process.stderr.write(`[runtime-load-test] ${error.message}\n`);
    process.exitCode = 1;
});
