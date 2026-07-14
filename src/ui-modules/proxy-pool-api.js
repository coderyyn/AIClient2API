import { existsSync, readFileSync } from 'fs';
import axios from 'axios';
import { getRequestBody } from '../utils/common.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { serviceInstances } from '../providers/adapter.js';
import logger from '../utils/logger.js';
import { getProxyPoolsFilePath, normalizeProxyPools } from '../utils/proxy-pool-store.js';
import { configureAxiosProxy } from '../utils/proxy-utils.js';

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
        return await withFileLock(filePath, async () => {
            const previous = existsSync(filePath)
                ? normalizeProxyPools(JSON.parse(readFileSync(filePath, 'utf8')))
                : [];
            const proxies = normalizeProxyPools(body?.proxies || body);
            const changedProxyIds = diffProxyIds(previous, proxies);

            await atomicWriteFile(filePath, JSON.stringify(proxies, null, 2), { encoding: 'utf-8', mode: 0o600 });
            const invalidatedAdapters = invalidateAdaptersForProxyIds(currentConfig, changedProxyIds);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                proxies,
                invalidatedAdapters
            }));
            return true;
        });
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleTestProxyPool(req, res, currentConfig) {
    const body = await getRequestBody(req);
    const proxyId = String(body?.proxyId || '').trim();

    try {
        const filePath = getProxyPoolsFilePath(currentConfig);
        const proxies = existsSync(filePath)
            ? normalizeProxyPools(JSON.parse(readFileSync(filePath, 'utf8')))
            : [];
        const proxy = proxies.find(entry => entry.id === proxyId);

        if (!proxyId || !proxy) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { message: 'Proxy not found' } }));
            return true;
        }

        if (proxy.enabled === false) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, proxyId, name: proxy.name, error: { message: 'Proxy is disabled' } }));
            return true;
        }

        const axiosConfig = {
            timeout: 15000,
            headers: {
                Accept: 'application/json'
            }
        };
        configureAxiosProxy(axiosConfig, {
            ...currentConfig,
            uuid: 'proxy-pool-test',
            customName: proxy.name || proxy.id,
            PROXY_ID: proxy.id
        }, 'openai-codex-oauth');

        const response = await axios.get('https://api.ipify.org?format=json', axiosConfig);
        const ip = String(response?.data?.ip || '').trim();
        const expectedIp = proxy.expectedIp || '';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: Boolean(ip),
            proxyId: proxy.id,
            name: proxy.name,
            ip,
            expectedIp,
            matched: expectedIp ? ip === expectedIp : null
        }));
        return true;
    } catch (error) {
        logger.warn('[Proxy Pool] Proxy test failed:', error.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: false,
            proxyId,
            error: { message: error.message }
        }));
        return true;
    }
}
