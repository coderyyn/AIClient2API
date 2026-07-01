import logger from '../../utils/logger.js';
import { buildRequestAuditEvent, normalizeUsage } from './audit-event.js';
import { getAnalysisStore, getAuditStore, handleRequestAuditRoutes, setAnalysisStore, setAuditStore, setRawCaptureController } from './api-routes.js';
import { createRequestAuditAnalyzerRunner } from './analyzer-runner.js';
import { RequestAuditRawCaptureStore, shouldCaptureRawRequest } from './raw-capture-store.js';

const pendingUsage = new Map();
const auditQueue = [];
let enabled = true;
let store = null;
let flushPromise = null;
let lastCleanupAt = 0;
let cleanupTimer = null;
let cleanupInFlight = false;
let analyzerRunner = null;
let rawCaptureStore = null;
let rawCaptureOptions = { enabled: false, keyHashes: [] };

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_AUDIT_QUEUE_EVENTS = 1000;
const AUDIT_FLUSH_BATCH_SIZE = 5;

function nextTick() {
    return new Promise(resolve => setImmediate(resolve));
}

function mergeUsage(base, next) {
    const normalized = normalizeUsage(next);
    return {
        promptTokens: Math.max(base?.promptTokens || 0, normalized.promptTokens),
        cachedTokens: Math.max(base?.cachedTokens || 0, normalized.cachedTokens),
        completionTokens: Math.max(base?.completionTokens || 0, normalized.completionTokens),
        reasoningTokens: Math.max(base?.reasoningTokens || 0, normalized.reasoningTokens),
        totalTokens: Math.max(base?.totalTokens || 0, normalized.totalTokens)
    };
}

function extractUsage(...candidates) {
    return candidates.reduce((usage, candidate) => {
        if (!candidate) return usage;
        if (Array.isArray(candidate)) {
            return candidate.reduce((inner, item) => mergeUsage(inner, item?.usage || item), usage);
        }
        return mergeUsage(usage, candidate.usage || candidate.message?.usage || candidate.usageMetadata || candidate.response?.usage || candidate);
    }, {
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
    });
}

function getRequestId(context = {}) {
    return context.requestId || context._monitorRequestId || null;
}

function setPendingUsage(requestId, usage) {
    if (!requestId) return;
    pendingUsage.set(requestId, {
        usage: mergeUsage(pendingUsage.get(requestId)?.usage, usage),
        updatedAt: Date.now()
    });
}

function cleanupPendingUsage() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [requestId, entry] of pendingUsage.entries()) {
        if ((entry.updatedAt || 0) < cutoff) {
            pendingUsage.delete(requestId);
        }
    }
}

function enqueueAuditContext(context) {
    if (!store) return;
    if (auditQueue.length >= MAX_AUDIT_QUEUE_EVENTS) {
        logger.warn('[Request Audit] Dropping audit event because queue is full');
        return;
    }
    auditQueue.push(context);
    scheduleAuditFlush();
}

function scheduleAuditFlush() {
    if (!flushPromise) {
        flushPromise = flushAuditQueue().finally(() => {
            flushPromise = null;
            if (auditQueue.length > 0) {
                scheduleAuditFlush();
            }
        });
    }
}

async function flushAuditQueue() {
    while (auditQueue.length > 0) {
        const batchSize = Math.min(auditQueue.length, AUDIT_FLUSH_BATCH_SIZE);
        for (let i = 0; i < batchSize; i += 1) {
            const context = auditQueue.shift();
            if (!context) continue;

            try {
                const event = buildRequestAuditEvent(context);
                await store.append(event);
                if (shouldCaptureRawRequest(rawCaptureOptions, event) && rawCaptureStore) {
                    await rawCaptureStore.capture({
                        ...event,
                        originalRequestBody: context.originalRequestBody,
                        processedRequestBody: context.processedRequestBody
                    });
                }
            } catch (error) {
                logger.warn('[Request Audit] Failed to write audit event:', error.message);
            }
        }
        if (auditQueue.length > 0) await nextTick();
    }
}

function scheduleAuditCleanup() {
    if (!store || cleanupInFlight) return;
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

    lastCleanupAt = now;
    cleanupInFlight = true;
    Promise.all([
        store.cleanup(),
        rawCaptureStore?.cleanup?.()
    ])
        .catch(error => {
            logger.warn('[Request Audit] Failed to cleanup audit store:', error.message);
        })
        .finally(() => {
            cleanupInFlight = false;
        });
}

function createRawCaptureController() {
    return {
        async getStatus() {
            return {
                enabled: rawCaptureOptions.enabled === true || rawCaptureOptions.enabled === 'true',
                keyHashes: Array.isArray(rawCaptureOptions.keyHashes) ? rawCaptureOptions.keyHashes : [],
                ttlMinutes: rawCaptureStore?.ttlMinutes || 60,
                maxBytes: rawCaptureStore?.maxBytes || 1024 * 1024,
                dir: rawCaptureStore?.dir || null,
                fileCount: await rawCaptureStore?.countFiles?.() || 0
            };
        },
        updateOptions(options = {}) {
            rawCaptureOptions = {
                enabled: options.enabled === true || options.enabled === 'true',
                keyHashes: Array.isArray(options.keyHashes) ? options.keyHashes : []
            };
            rawCaptureStore?.updateOptions?.({
                ttlMinutes: options.ttlMinutes,
                maxBytes: options.maxBytes
            });
        }
    };
}

function startCleanupTimer() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = setInterval(scheduleAuditCleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
}

function cleanupRawCaptureOnInit() {
    Promise.resolve(rawCaptureStore?.cleanup?.())
        .catch(error => {
            logger.warn('[Request Audit] Failed to cleanup raw capture store:', error.message);
        });
}

const requestAuditPlugin = {
    name: 'request-audit',
    version: '1.0.0',
    description: '请求审计：安全记录每次请求的审计明细、OpenAI usage 和近似上下文 token 分类；默认不保存原始 prompt、图片原文、完整 key、token 或 cookie。<br>API: <code>/api/request-audit</code><br>页面：<a href="request-audit.html" target="_blank">request-audit.html</a>',
    type: 'middleware',
    _builtin: true,
    _priority: 8990,
    staticPaths: ['request-audit.html'],
    routes: [
        {
            method: '*',
            path: '/api/request-audit',
            handler: handleRequestAuditRoutes
        }
    ],

    async init(config = {}) {
        enabled = config.REQUEST_AUDIT_ENABLED !== false && config.REQUEST_AUDIT_ENABLED !== 'false';
        store = config._requestAuditStore || getAuditStore(config);
        setAuditStore(store);
        const materializedStore = config._requestAuditAnalysisStore || getAnalysisStore(config);
        setAnalysisStore(materializedStore);
        rawCaptureStore = config._requestAuditRawCaptureStore || new RequestAuditRawCaptureStore({
            dir: config.REQUEST_AUDIT_RAW_CAPTURE_DIR,
            ttlMinutes: config.REQUEST_AUDIT_RAW_CAPTURE_TTL_MINUTES || 60,
            maxBytes: config.REQUEST_AUDIT_RAW_CAPTURE_MAX_BYTES || 1024 * 1024
        });
        rawCaptureOptions = {
            enabled: config.REQUEST_AUDIT_RAW_CAPTURE_ENABLED === true || config.REQUEST_AUDIT_RAW_CAPTURE_ENABLED === 'true',
            keyHashes: config.REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES || []
        };
        setRawCaptureController(createRawCaptureController());
        lastCleanupAt = 0;
        startCleanupTimer();
        cleanupRawCaptureOnInit();
        if (config.REQUEST_AUDIT_ANALYZER_ENABLED !== false && config.REQUEST_AUDIT_ANALYZER_ENABLED !== 'false') {
            analyzerRunner = createRequestAuditAnalyzerRunner({
                auditStore: store,
                analysisStore: materializedStore,
                intervalMs: config.REQUEST_AUDIT_ANALYZER_INTERVAL_MS || 60000,
                lookbackMinutes: config.REQUEST_AUDIT_ANALYZER_LOOKBACK_MINUTES || 180,
                maxEvents: config.REQUEST_AUDIT_ANALYZER_MAX_EVENTS || 5000,
                runOnInit: config.REQUEST_AUDIT_ANALYZER_RUN_ON_INIT === true || config.REQUEST_AUDIT_ANALYZER_RUN_ON_INIT === 'true'
            });
            analyzerRunner.start();
        }
        logger.info(`[Request Audit] Initialized enabled=${enabled}`);
    },

    async destroy() {
        pendingUsage.clear();
        auditQueue.length = 0;
        if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }
        if (analyzerRunner) {
            analyzerRunner.stop();
            analyzerRunner = null;
        }
        rawCaptureStore = null;
        rawCaptureOptions = { enabled: false, keyHashes: [] };
        setRawCaptureController(null);
        logger.info('[Request Audit] Destroyed');
    },

    hooks: {
        async onUnaryResponse({ requestId, nativeResponse, clientResponse }) {
            if (!enabled || !requestId) return;
            setPendingUsage(requestId, extractUsage(nativeResponse, clientResponse));
        },

        async onStreamChunk({ requestId, nativeChunk, chunkToSend }) {
            if (!enabled || !requestId) return;
            setPendingUsage(requestId, extractUsage(nativeChunk, chunkToSend));
        },

        async onContentGenerated(context = {}) {
            if (!enabled) return;
            const requestId = getRequestId(context);
            if (!requestId) return;

            try {
                cleanupPendingUsage();
                const usage = pendingUsage.get(requestId)?.usage || {};
                enqueueAuditContext({
                    ...context,
                    requestId,
                    usage,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                logger.warn('[Request Audit] Failed to enqueue audit event:', error.message);
            } finally {
                pendingUsage.delete(requestId);
            }
        }
    }
};

export default requestAuditPlugin;
