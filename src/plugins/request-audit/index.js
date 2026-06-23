import logger from '../../utils/logger.js';
import { buildRequestAuditEvent, normalizeUsage } from './audit-event.js';
import { getAuditStore, handleRequestAuditRoutes, setAuditStore } from './api-routes.js';

const pendingUsage = new Map();
let enabled = true;
let store = null;

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

const requestAuditPlugin = {
    name: 'request-audit',
    version: '1.0.0',
    description: 'Privacy-safe per-request audit logs and approximate context usage breakdown<br>API: <code>/api/request-audit</code><br>Page: <a href="request-audit.html" target="_blank">request-audit.html</a>',
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
        logger.info(`[Request Audit] Initialized enabled=${enabled}`);
    },

    async destroy() {
        pendingUsage.clear();
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
                await store.append(event);
                await store.cleanup();
            } catch (error) {
                logger.warn('[Request Audit] Failed to write audit event:', error.message);
            } finally {
                pendingUsage.delete(requestId);
            }
        }
    }
};

export default requestAuditPlugin;
