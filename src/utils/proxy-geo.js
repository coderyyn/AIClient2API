import axios from 'axios';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { withFileLock, atomicWriteFile } from './file-lock.js';
import { getProxyPoolsFilePath, normalizeProxyPools, proxyRouteHash, proxyGeoIsVerified } from './proxy-pool-store.js';
import { parseProxyUrl } from './proxy-utils.js';

const pending = new Map();
export async function detectProxyGeo(entry) {
    const checkedAt = new Date().toISOString();
    const base = { status: 'error', checkedAt, routeHash: proxyRouteHash(entry) };
    let observed = {};
    try {
        const agent = parseProxyUrl(entry.url);
        if (!agent) throw Object.assign(new Error(), { code: 'PROXY_URL_INVALID' });
        const response = await axios.get('https://get.geojs.io/v1/ip/geo.json', {
            proxy: false, httpAgent: agent.httpAgent, httpsAgent: agent.httpsAgent,
            timeout: 15000, maxRedirects: 0, maxContentLength: 64 * 1024,
            headers: { Accept: 'application/json' }
        });
        const data = response?.data || {};
        const geo = { ...base, status: 'verified', ip: String(data.ip || ''),
            countryCode: String(data.country_code || '').toUpperCase(), country: String(data.country || ''),
            region: String(data.region || ''), city: String(data.city || ''), timezone: String(data.timezone || '') };
        observed = geo;
        if (!isIP(geo.ip) || !proxyGeoIsVerified({ ...entry, geo })) throw Object.assign(new Error(), { code: 'PROXY_GEO_INCOMPLETE' });
        if (entry.expectedIp && entry.expectedIp !== geo.ip) throw Object.assign(new Error(), { code: 'PROXY_EXIT_IP_MISMATCH' });
        return geo;
    } catch (error) {
        const code = ['PROXY_URL_INVALID', 'PROXY_GEO_INCOMPLETE', 'PROXY_EXIT_IP_MISMATCH'].includes(error.code)
            ? error.code : 'PROXY_GEO_LOOKUP_FAILED';
        return { ...observed, ...base, status: 'error', errorCode: code, ...(entry.geo?.status === 'verified' ? { lastSuccess: entry.geo } : entry.geo?.lastSuccess ? { lastSuccess: entry.geo.lastSuccess } : {}) };
    }
}

/** Network work stays outside the file lock. A route change rejects stale results. */
export function refreshProxyGeo(config, entry) {
    const path = getProxyPoolsFilePath(config);
    const key = `${path}:${entry.id}:${proxyRouteHash(entry)}`;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
        const geo = await detectProxyGeo(entry);
        return withFileLock(path, async () => {
            const entries = normalizeProxyPools(JSON.parse(readFileSync(path, 'utf8')));
            const current = entries.find(item => item.id === entry.id);
            if (!current || proxyRouteHash(current) !== proxyRouteHash(entry) || current.enabled !== entry.enabled) return null;
            current.geo = geo;
            await atomicWriteFile(path, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
            return current;
        });
    })().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
}
