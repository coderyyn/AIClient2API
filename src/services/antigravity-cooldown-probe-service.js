import logger from '../utils/logger.js';
import { AntigravityApiService } from '../providers/gemini/antigravity-core.js';
import { ANTIGRAVITY_PROVIDER, normalizeProbeModel } from '../providers/antigravity-cooldown-state.js';
import { getAntigravityExplicitRecoveryTime } from '../utils/common.js';

export const ANTIGRAVITY_COOLDOWN_PROBE_INTERVAL_MS = 10 * 60 * 1000;

export async function validateCooldownProbeResponse(model, response) {
    const reported = response?.modelVersion || response?.model;
    if (reported && normalizeProbeModel(reported) !== normalizeProbeModel(model)) return false;
    const candidate = response?.candidates?.[0];
    // 文本模型只要目标模型返回了成功响应即可恢复，不判断终止原因和答案内容
    // （思考型模型可能在输出上限内只产生思考内容）。
    if (!model.includes('image')) return Boolean(candidate);
    if (candidate?.finishReason !== 'STOP') return false;
    const parts = candidate.content?.parts || [];
    const { default: sharp } = await import('sharp');
    for (const part of parts) {
        const data = part.inlineData;
        if (!data?.mimeType?.startsWith('image/') || typeof data.data !== 'string'
            || !data.data.length || data.data.length > 24 * 1024 * 1024) continue;
        try {
            const decoded = await sharp(Buffer.from(data.data, 'base64'), { limitInputPixels: 16777216 })
                .raw().toBuffer({ resolveWithObject: true });
            if (decoded.info.width > 0 && decoded.info.height > 0 && decoded.data.length) return true;
        } catch { /* A header or truncated image is not a completed generation. */ }
    }
    return false;
}

export class AntigravityCooldownProbeService {
    constructor(config, manager, { log = logger, serviceFactory = c => new AntigravityApiService(c),
        multiWorker = process.env.RUNTIME_MULTI_WORKER_ENABLED === 'true' } = {}) {
        this.config = config;
        this.manager = manager;
        this.log = log;
        this.serviceFactory = serviceFactory;
        this.multiWorker = multiWorker;
        this.controllers = new Set();
        this.timer = null;
        this.running = null;
        this.stopped = false;
    }

    start() {
        if (this.timer) return this;
        this.stopped = false;
        this.timer = setInterval(() => { void this.runOnce(); }, ANTIGRAVITY_COOLDOWN_PROBE_INTERVAL_MS);
        this.timer.unref?.();
        return this;
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = null;
        for (const controller of this.controllers) controller.abort();
        await this.running;
    }

    runOnce() {
        if (this.running || this.stopped || this.config.ANTIGRAVITY_COOLDOWN_PROBE_ENABLED === false) return this.running;
        this.running = this.sweep().catch(() => {
            this.log.warn('[Antigravity Cooldown Probe] Sweep failed');
        }).finally(() => { this.running = null; });
        return this.running;
    }

    async sweep() {
        if (this.multiWorker && !this.manager.coordination) return;
        const tasks = this.manager.listAntigravityCooldownProbes();
        if (!tasks.length) return;
        const groups = new Map();
        for (const task of tasks) {
            if (!groups.has(task.uuid)) groups.set(task.uuid, new Map());
            groups.get(task.uuid).set(task.canonical, task);
        }
        const queue = [...groups.values()].map(group => [...group.values()]);
        const counts = { scanned: tasks.length, probed: 0, recovered: 0, failed: 0, skipped: 0 };
        const worker = async () => {
            while (queue.length) {
                const group = queue.shift();
                for (const task of group) {
                    if (this.stopped || this.config.ANTIGRAVITY_COOLDOWN_PROBE_ENABLED === false) { counts.skipped++; continue; }
                    const result = await this.probe(task);
                    if (result.probed) counts.probed++;
                    counts[result.status]++;
                }
            }
        };
        await Promise.all([worker(), worker()]);
        this.log.info(`[Antigravity Cooldown Probe] ${JSON.stringify(counts)}`);
    }

    async probe(task) {
        const coordination = this.manager.coordination;
        const timeoutMs = task.canonical.includes('image') ? 180_000 : 60_000;
        let owner, release, service, timer, controller;
        let probed = false;
        const startedAt = Date.now();
        let http = null, status = 'skipped', recoveryTime = null;
        try {
            if (!this.manager.getAntigravityCooldownProbeTarget(task)) return { status, probed };
            let redisSnapshot;
            if (coordination) {
                owner = await coordination.acquireProviderModelProbe(ANTIGRAVITY_PROVIDER, task.uuid, task.canonical, { ttlMs: timeoutMs + 30_000 });
                if (!owner) return { status, probed };
                redisSnapshot = await coordination.getProviderModelCooldown(ANTIGRAVITY_PROVIDER, task.uuid, task.canonical);
                if (redisSnapshot.revision && JSON.parse(redisSnapshot.revision).version !== task.version) {
                    const state = this.manager.getAntigravityCooldownProbeTarget(task)?.config.antigravityQuotaHealth.models[task.model];
                    if (state?.source !== 'cooldown_probe_rollback'
                        || state.supersedesVersion !== JSON.parse(redisSnapshot.revision).version
                        || !await coordination.compareProviderModelCooldown(ANTIGRAVITY_PROVIDER, task.uuid, task.canonical, redisSnapshot, state)) return { status, probed };
                    redisSnapshot = await coordination.getProviderModelCooldown(ANTIGRAVITY_PROVIDER, task.uuid, task.canonical);
                    if (JSON.parse(redisSnapshot.revision || '{}').version !== task.version) return { status, probed };
                }
            }
            release = await this.manager.acquireAntigravityCooldownProbeSlot(task);
            if (!release) return { status, probed };
            const target = this.manager.getAntigravityCooldownProbeTarget(task);
            if (!target || this.stopped || this.config.ANTIGRAVITY_COOLDOWN_PROBE_ENABLED === false) return { status, probed };
            controller = new AbortController();
            this.controllers.add(controller);
            timer = setTimeout(() => controller.abort(), timeoutMs);
            timer.unref?.();
            service = this.serviceFactory({ ...this.manager.globalConfig, ...target.config, MODEL_PROVIDER: ANTIGRAVITY_PROVIDER });
            const image = task.canonical.includes('image');
            const body = {
                contents: [{ role: 'user', parts: [{ text: image
                    ? 'Generate an image of a small red circle on a plain white background.'
                    : 'Calculate 17 + 26. Reply with only the integer result.' }] }],
                generationConfig: image ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } }
                    : { temperature: 0, maxOutputTokens: 256 }
            };
            probed = true;
            let success = false;
            try {
                const result = await service.probeCooldownModel(task.canonical, body, { signal: controller.signal, timeoutMs });
                http = result.http;
                success = http === 200 && await validateCooldownProbeResponse(result.outboundModel || task.canonical, result.response);
                controller.signal.throwIfAborted();
            } catch (error) {
                http = error.response?.status || error.status || null;
                if (http === 429 && !controller.signal.aborted) {
                    recoveryTime = getAntigravityExplicitRecoveryTime(error, Date.now(), this.config);
                }
            }
            status = 'failed';
            if (!controller.signal.aborted && !this.stopped && this.config.ANTIGRAVITY_COOLDOWN_PROBE_ENABLED !== false
                && (success || recoveryTime)) {
                const applied = await this.manager.applyAntigravityCooldownProbeResult(task, { success, recoveryTime }, redisSnapshot, startedAt);
                status = applied ? (success ? 'recovered' : 'failed') : 'skipped';
            }
        } catch { status = probed ? 'failed' : 'skipped'; }
        finally {
            clearTimeout(timer);
            if (controller) this.controllers.delete(controller);
            service?.httpAgent?.destroy();
            service?.httpsAgent?.destroy();
            try { await release?.(); } catch { this.log.warn('[Antigravity Cooldown Probe] Capacity release failed'); }
            if (owner) {
                try { await coordination.releaseProviderModelProbe(ANTIGRAVITY_PROVIDER, task.uuid, task.canonical, owner); }
                catch { this.log.warn('[Antigravity Cooldown Probe] Probe lock release failed'); }
            }
            this.log.info(`[Antigravity Cooldown Probe] ${JSON.stringify({ uuid: task.uuid, model: task.canonical,
                status, http, recoveryTime, elapsedMs: Date.now() - startedAt })}`);
        }
        return { status, probed };
    }
}
