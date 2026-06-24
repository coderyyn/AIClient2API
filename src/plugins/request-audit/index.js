import logger from '../../utils/logger.js';
import { buildRequestAuditEvent, normalizeUsage } from './audit-event.js';
import { getAuditStore, handleRequestAuditRoutes, setAuditStore } from './api-routes.js';

const pendingUsage = new Map();
const auditQueue = [];
let enabled = true;
let store = null;
let flushPromise = null;
let lastCleanupAt = 0;
let cleanupTimer = null;
let cleanupInFlight = false;

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

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

function enqueueAuditEvent(event) {
    if (!store) return;
    auditQueue.push(event);
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
        const event = auditQueue.shift();
        if (!event) continue;

        try {
            await store.append(event);
        } catch (error) {
            logger.warn('[Request Audit] Failed to write audit event:', error.message);
        }
    }
}

function scheduleAuditCleanup() {
    if (!store || cleanupInFlight) return;
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

    lastCleanupAt = now;
    cleanupInFlight = true;
    store.cleanup()
        .catch(error => {
            logger.warn('[Request Audit] Failed to cleanup audit store:', error.message);
        })
        .finally(() => {
            cleanupInFlight = false;
        });
}

function startCleanupTimer() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = setInterval(scheduleAuditCleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
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
        lastCleanupAt = 0;
        startCleanupTimer();
        logger.info(`[Request Audit] Initialized enabled=${enabled}`);
    },

    async destroy() {
        pendingUsage.clear();
        auditQueue.length = 0;
        if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }
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
                const event = buildRequestAuditEvent({
                    ...context,
                    requestId,
                    usage,
                    timestamp: new Date().toISOString()
                });
                enqueueAuditEvent(event);
            } catch (error) {
                logger.warn('[Request Audit] Failed to enqueue audit event:', error.message);
            } finally {
                pendingUsage.delete(requestId);
            }
        }
    }
};

export default requestAuditPlugin;
