import { RequestAuditStore } from './audit-store.js';

let auditStore = null;

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function addUsage(target, usage = {}) {
    target.requestCount += 1;
    target.promptTokens += toNumber(usage.promptTokens);
    target.cachedTokens += toNumber(usage.cachedTokens);
    target.completionTokens += toNumber(usage.completionTokens);
    target.reasoningTokens += toNumber(usage.reasoningTokens);
    target.totalTokens += toNumber(usage.totalTokens);
    target.cacheHitRatio = target.promptTokens > 0 ? target.cachedTokens / target.promptTokens : 0;
}

function ensureBucket(map, key) {
    const bucketKey = key || 'unknown';
    if (!map[bucketKey]) {
        map[bucketKey] = {
            requestCount: 0,
            promptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheHitRatio: 0
        };
    }
    return map[bucketKey];
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

export function setAuditStore(store) {
    auditStore = store;
}

export function getAuditStore(config = {}) {
    if (config._requestAuditStore) return config._requestAuditStore;
    if (!auditStore) {
        auditStore = new RequestAuditStore({
            dir: config.REQUEST_AUDIT_DIR,
            retentionHours: config.REQUEST_AUDIT_RETENTION_HOURS,
            maxFileBytes: config.REQUEST_AUDIT_MAX_FILE_BYTES
        });
    }
    return auditStore;
}

export function buildAuditSummary(events = []) {
    const result = {
        summary: {
            requestCount: 0,
            promptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheHitRatio: 0
        },
        models: {},
        accounts: {},
        contextSections: {}
    };

    for (const event of events) {
        const usage = event.usage || {};
        addUsage(result.summary, usage);
        addUsage(ensureBucket(result.models, event.request?.model), usage);
        addUsage(ensureBucket(result.accounts, event.account?.providerNameDisplay || event.account?.providerUuid), usage);

        for (const section of event.contextBreakdown?.sections || []) {
            const id = section.id || 'unknown';
            if (!result.contextSections[id]) {
                result.contextSections[id] = { tokens: 0, percentOfPrompt: 0 };
            }
            result.contextSections[id].tokens += toNumber(section.calibratedTokens ?? section.tokens);
        }
    }

    for (const section of Object.values(result.contextSections)) {
        section.percentOfPrompt = result.summary.promptTokens > 0 ? section.tokens / result.summary.promptTokens : 0;
    }

    return result;
}

function parseQuery(requestUrl) {
    return {
        keyHash: requestUrl.searchParams.get('keyHash') || undefined,
        keyPrefix: requestUrl.searchParams.get('keyPrefix') || undefined,
        requestId: requestUrl.searchParams.get('requestId') || undefined,
        since: requestUrl.searchParams.get('since') || undefined,
        until: requestUrl.searchParams.get('until') || undefined,
        model: requestUrl.searchParams.get('model') || undefined,
        provider: requestUrl.searchParams.get('provider') || undefined,
        outcome: requestUrl.searchParams.get('outcome') || undefined,
        limit: requestUrl.searchParams.get('limit') || undefined
    };
}

export async function handleRequestAuditRoutes(method, path, req, res, config = {}) {
    if (!path.startsWith('/api/request-audit')) return false;
    if (method !== 'GET') {
        sendJson(res, 405, { success: false, error: { message: 'Method not allowed' } });
        return true;
    }

    const requestUrl = new URL(req.url || path, 'http://localhost');
    const store = getAuditStore(config);
    const filters = parseQuery(requestUrl);

    if (path === '/api/request-audit/summary') {
        const events = await store.query(filters);
        sendJson(res, 200, {
            success: true,
            data: {
                window: { since: filters.since || null, until: filters.until || null },
                ...buildAuditSummary(events)
            }
        });
        return true;
    }

    if (path === '/api/request-audit/requests') {
        const events = await store.query(filters);
        sendJson(res, 200, { success: true, data: { requests: events } });
        return true;
    }

    sendJson(res, 404, { success: false, error: { message: 'Request audit endpoint not found' } });
    return true;
}
