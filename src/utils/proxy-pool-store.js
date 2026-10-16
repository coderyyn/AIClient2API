import { existsSync, readFileSync } from 'fs';
import { createHash } from 'node:crypto';

export const CODEX_PROXY_SNAPSHOT = Symbol('codexProxySnapshot');
export function proxyRouteHash(entry = {}) {
    return createHash('sha256').update(JSON.stringify([entry.url || '', entry.expectedIp || ''])).digest('hex');
}
export function proxyGeoIsVerified(entry) {
    if (!entry || entry.enabled === false || entry.geo?.status !== 'verified' || entry.geo.routeHash !== proxyRouteHash(entry)) return false;
    if (entry.expectedIp && entry.expectedIp !== entry.geo.ip) return false;
    if (!/^[A-Z]{2}$/.test(entry.geo.countryCode || '') || !entry.geo.ip || !entry.geo.timezone) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: entry.geo.timezone }); return true; } catch { return false; }
}
export function assertVerifiedCodexProxy(config = {}, proxyId = config.PROXY_ID) {
    if (!String(proxyId || '').trim()) return null;
    const entry = config[CODEX_PROXY_SNAPSHOT] || resolveProxyPoolEntry({ ...config, PROXY_ID: proxyId });
    if (!entry || entry.id !== proxyId || !proxyGeoIsVerified(entry)) {
        const error = new Error('代理尚未取得有效国家和时区，请在代理管理中重新检测。');
        error.code = 'PROXY_GEO_UNVERIFIED';
        error.status = 409;
        error.statusCode = 409;
        throw error;
    }
    return entry;
}
export function assertCodexProxyBinding(config, providerType, next = {}, previous = {}) {
    if (providerType?.startsWith('openai-codex-oauth') && next.PROXY_ID && next.PROXY_ID !== previous.PROXY_ID) {
        assertVerifiedCodexProxy(config, next.PROXY_ID);
    }
}

const DEFAULT_PROXY_POOLS_FILE_PATH = 'configs/proxy-pools.json';

export function getProxyPoolsFilePath(config = {}) {
    return config.PROXY_POOLS_FILE_PATH || DEFAULT_PROXY_POOLS_FILE_PATH;
}

function stripHtml(value) {
    return String(value || '').replace(/<[^>]*>/g, '').trim();
}

export function sanitizeProxyPoolEntry(entry = {}) {
    return {
        id: stripHtml(entry.id).replace(/[^a-zA-Z0-9_.:-]/g, ''),
        name: stripHtml(entry.name),
        url: String(entry.url || '').trim(),
        enabled: entry.enabled !== false,
        expectedIp: stripHtml(entry.expectedIp),
        note: stripHtml(entry.note),
        ...(entry.geo && typeof entry.geo === 'object' ? { geo: {
            status: ['verified', 'error', 'unverified'].includes(entry.geo.status) ? entry.geo.status : 'unverified',
            ip: stripHtml(entry.geo.ip), countryCode: stripHtml(entry.geo.countryCode),
            country: stripHtml(entry.geo.country), region: stripHtml(entry.geo.region), city: stripHtml(entry.geo.city),
            timezone: stripHtml(entry.geo.timezone), checkedAt: stripHtml(entry.geo.checkedAt),
            routeHash: stripHtml(entry.geo.routeHash), errorCode: stripHtml(entry.geo.errorCode),
            ...(entry.geo.lastSuccess ? { lastSuccess: entry.geo.lastSuccess } : {})
        } } : {})
    };
}

export function normalizeProxyPools(input) {
    const list = Array.isArray(input) ? input : [];
    const seen = new Set();
    return list
        .map(sanitizeProxyPoolEntry)
        .filter(entry => {
            if (!entry.id || !entry.url || seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
        });
}

export function loadProxyPoolsSync(config = {}) {
    const filePath = getProxyPoolsFilePath(config);
    if (!filePath || !existsSync(filePath)) {
        return [];
    }

    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeProxyPools(data);
}

export function resolveProxyPoolEntry(config = {}) {
    const proxyId = String(config.PROXY_ID || '').trim();
    if (!proxyId) {
        return null;
    }

    const proxyPools = loadProxyPoolsSync(config);
    return proxyPools.find(entry => entry.id === proxyId && entry.enabled !== false) || null;
}
