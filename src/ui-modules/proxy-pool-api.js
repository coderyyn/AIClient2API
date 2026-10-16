import { existsSync, readFileSync } from 'fs';
import { getRequestBody } from '../utils/common.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { serviceInstances } from '../providers/adapter.js';
import logger from '../utils/logger.js';
import { getProxyPoolsFilePath, normalizeProxyPools, proxyRouteHash, proxyGeoIsVerified } from '../utils/proxy-pool-store.js';
import { refreshProxyGeo } from '../utils/proxy-geo.js';

function getProviderPoolsFilePath(currentConfig = {}) {
    return currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
}

function loadProviderPools(currentConfig = {}) {
    const filePath = getProviderPoolsFilePath(currentConfig);
    if (!existsSync(filePath)) {
        return {};
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

function invalidateAdaptersForProxyIds(currentConfig, changedProxyIds) {
    if (!changedProxyIds || changedProxyIds.size === 0) return 0;

    let providerPools = {};
    try {
        providerPools = loadProviderPools(currentConfig);
    } catch (error) {
        logger.warn('[Proxy Pool] Failed to read provider pools for adapter invalidation:', error.message);
        return 0;
    }

    let invalidated = 0;
    for (const [providerType, providers] of Object.entries(providerPools)) {
        if (!Array.isArray(providers)) continue;

        providers.forEach(provider => {
            if (!provider?.uuid || !changedProxyIds.has(provider.PROXY_ID)) return;
            const key = `${providerType}${provider.uuid}`;
            if (serviceInstances[key]) {
                delete serviceInstances[key];
                invalidated++;
            }
        });
    }

    if (invalidated > 0) {
        logger.info(`[Proxy Pool] Invalidated ${invalidated} service adapter(s) after proxy pool change`);
    }
    return invalidated;
}

function diffProxyIds(previous, next) {
    const previousMap = new Map(previous.map(entry => [entry.id, entry]));
    const nextMap = new Map(next.map(entry => [entry.id, entry]));
    const ids = new Set([...previousMap.keys(), ...nextMap.keys()]);
    const changed = new Set();

    ids.forEach(id => {
        if (JSON.stringify(previousMap.get(id) || null) !== JSON.stringify(nextMap.get(id) || null)) {
            changed.add(id);
        }
    });
    return changed;
}

export async function handleGetProxyPools(req, res, currentConfig) {
    try {
        const filePath = getProxyPoolsFilePath(currentConfig);
        const proxies = existsSync(filePath)
            ? normalizeProxyPools(JSON.parse(readFileSync(filePath, 'utf8')))
            : [];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proxies }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleSaveProxyPools(req, res, currentConfig) {
    const body = await getRequestBody(req);
    const filePath = getProxyPoolsFilePath(currentConfig);
    try {
        const detect = [];
        let invalidatedAdapters = 0;
        await withFileLock(filePath, async () => {
            const previous = existsSync(filePath) ? normalizeProxyPools(JSON.parse(readFileSync(filePath, 'utf8'))) : [];
            const proxies = normalizeProxyPools(body?.proxies || body).map(entry => {
                const old = previous.find(item => item.id === entry.id);
                delete entry.geo; // Only persisted server results are trusted.
                if (old && proxyRouteHash(old) === proxyRouteHash(entry)) {
                    if (old.geo) entry.geo = old.geo;
                } else {
                    entry.geo = { status: 'unverified', routeHash: proxyRouteHash(entry) };
                    if (old?.geo?.status === 'verified') entry.geo.lastSuccess = old.geo;
                    if (entry.enabled) detect.push(entry);
                }
                return entry;
            });
            await atomicWriteFile(filePath, JSON.stringify(proxies, null, 2), { encoding: 'utf-8', mode: 0o600 });
            invalidatedAdapters = invalidateAdaptersForProxyIds(currentConfig, diffProxyIds(previous, proxies));
        });
        // Bounded concurrency, no network calls inside the write lock.
        for (let i = 0; i < detect.length; i += 3) {
            await Promise.all(detect.slice(i, i + 3).map(entry => refreshProxyGeo(currentConfig, entry)));
        }
        const proxies = normalizeProxyPools(JSON.parse(readFileSync(filePath, 'utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, proxies, invalidatedAdapters }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Proxy pool save failed' } }));
        return true;
    }
}

export async function handleTestProxyPool(req, res, currentConfig) {
    const body = await getRequestBody(req);
    const proxyId = String(body?.proxyId || '').trim();
    try {
        const filePath = getProxyPoolsFilePath(currentConfig);
        const proxies = existsSync(filePath) ? normalizeProxyPools(JSON.parse(readFileSync(filePath, 'utf8'))) : [];
        const proxy = proxies.find(entry => entry.id === proxyId);
        if (!proxy || !proxy.enabled) {
            res.writeHead(proxy ? 400 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, proxyId, error: { message: proxy ? 'Proxy is disabled' : 'Proxy not found' } }));
            return true;
        }
        const updated = await refreshProxyGeo(currentConfig, proxy);
        const geo = updated?.geo;
        invalidateAdaptersForProxyIds(currentConfig, new Set([proxyId]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: proxyGeoIsVerified(updated), proxyId, name: proxy.name,
            ip: geo?.ip || '', expectedIp: proxy.expectedIp || '',
            matched: proxy.expectedIp && geo?.ip ? geo.ip === proxy.expectedIp : null,
            geo, bindable: proxyGeoIsVerified(updated),
            ...(!updated ? { error: { code: 'PROXY_CHANGED', message: 'Proxy changed during detection; retry' } } : {}) }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, proxyId, error: { message: 'Proxy detection failed' } }));
        return true;
    }
}
