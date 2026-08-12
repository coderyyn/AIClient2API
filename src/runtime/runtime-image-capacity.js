import fs from 'fs';
import { BigObjectCapacity, resolveBigObjectBudget, resolveImageQueueLimit } from './big-object-capacity.js';
import { runtimeMetrics } from './runtime-metrics.js';

function readContainerLimitBytes() {
    const configured = Number(process.env.RUNTIME_CONTAINER_MEMORY_LIMIT_BYTES);
    if (Number.isFinite(configured) && configured > 0) return configured;
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try {
            const value = fs.readFileSync(file, 'utf8').trim();
            const parsed = Number(value);
            if (value !== 'max' && Number.isFinite(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER) return parsed;
        } catch {}
    }
    return null;
}

const metrics = {};
export const runtimeImageCapacity = new BigObjectCapacity({
    budgetBytes: Number(process.env.RUNTIME_BIG_OBJECT_BUDGET_BYTES) || resolveBigObjectBudget({ containerLimitBytes: readContainerLimitBytes() }),
    queueLimit: 20,
    waitMs: Number(process.env.RUNTIME_IMAGE_QUEUE_WAIT_MS) || 10_000,
    metrics
});

export function estimateImageResponseBytes({ n = 1, inputBytes = 0 } = {}) {
    const images = Math.max(1, Number(n) || 1);
    const perImage = Number(process.env.RUNTIME_IMAGE_ESTIMATED_BYTES) || 6 * 1024 * 1024;
    return Math.ceil(images * perImage + Math.max(0, Number(inputBytes) || 0) * 1.5);
}

export function updateImageCapacitySignals(providerPoolManager) {
    const snapshot = runtimeMetrics.snapshot();
    metrics.rssBytes = snapshot.process.rss;
    metrics.rssLimitBytes = readContainerLimitBytes() || 0;
    metrics.eventLoopP95Ms = snapshot.stages.eventLoopDelay?.p95 || 0;
    metrics.backpressureMs = snapshot.output.backpressureMs > 1000 ? snapshot.output.backpressureMs : 0;
    const healthy = Object.keys(providerPoolManager?.providerStatus || {})
        .reduce((total, type) => total + providerPoolManager.getHealthyCount(type), 0);
    runtimeImageCapacity.queueLimit = resolveImageQueueLimit(healthy);
}
