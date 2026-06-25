import { existsSync, readFileSync } from 'fs';

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
        note: stripHtml(entry.note)
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
