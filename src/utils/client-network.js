import { isIP } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { Address6 } from 'ip-address';

export function normalizeClientIp(value) {
    if (!value || String(value).includes('%')) return null;
    const ip = String(value).trim();
    if (!isIP(ip)) return null;
    if (isIP(ip) === 6) {
        const a = new Address6(ip);
        return a.isMapped4() ? a.to4().correctForm() : a.correctForm();
    }
    return ip;
}

function trustedIps(value) {
    return (Array.isArray(value) ? value : String(value || '').split(','))
        .flatMap(x => Array.isArray(x) ? trustedIps(x) : [normalizeClientIp(x)]).filter(Boolean);
}
const signature = (secret, req, payload) => createHmac('sha256', secret).update(`${req.method}:${req.url}:${payload}`).digest('hex');
export function signNetworkHeaders(secret, req, network) {
    const payload = Buffer.from(JSON.stringify(network)).toString('base64url');
    return { 'x-aiclient-network': payload, 'x-aiclient-network-signature': signature(secret, req, payload) };
}

export function resolveClientNetwork(req, config = {}, options = {}) {
    const peerIp = normalizeClientIp(req.socket?.remoteAddress) || 'unknown';
    let network;
    if (process.env.RUNTIME_NETWORK_SECRET && process.env.RUNTIME_WORKER_ROLE && peerIp === '127.0.0.1') {
        const payload = req.headers?.['x-aiclient-network'];
        const supplied = req.headers?.['x-aiclient-network-signature'];
        try {
            if (typeof payload !== 'string' || payload.length > 2048 || !/^[a-f0-9]{64}$/.test(supplied || '')) throw Error('invalid envelope');
            const expected = signature(process.env.RUNTIME_NETWORK_SECRET, req, payload);
            if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw Error('invalid signature');
            const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
            if (!['peer', 'trusted-x-real-ip', 'trusted-x-forwarded-for'].includes(parsed.clientIpSource)) throw Error('invalid source');
            network = { clientIp: normalizeClientIp(parsed.clientIp) || 'unknown', peerIp: normalizeClientIp(parsed.peerIp) || 'unknown', clientIpSource: parsed.clientIpSource, ...([401,403,429,503].includes(parsed.edgeDeniedStatus) ? {edgeDeniedStatus:parsed.edgeDeniedStatus} : {}) };
        } catch { network = { clientIp: peerIp, peerIp, clientIpSource: 'unverified-runtime-peer' }; }
        return options.detailed ? network : config.TRUST_PROXY === true ? network.clientIp : peerIp;
    }
    network = { clientIp: peerIp, peerIp, clientIpSource: 'peer' };
    if (trustedIps(config.TRUSTED_PROXY_IPS).includes(peerIp) && (config.TRUST_PROXY === true || options.detailed)) {
        const real = normalizeClientIp(req.headers?.['x-real-ip']);
        const forwarded = normalizeClientIp(String(req.headers?.['x-forwarded-for'] || '').split(',')[0]);
        if (real) network = { clientIp: real, peerIp, clientIpSource: 'trusted-x-real-ip' };
        else if (forwarded) network = { clientIp: forwarded, peerIp, clientIpSource: 'trusted-x-forwarded-for' };
    }
    return options.detailed ? network : network.clientIp;
}

let cache;
export function readIngressNetworkConfig() {
    try {
        const file = 'configs/config.json'; const mtime = fs.statSync(file).mtimeMs;
        if (cache?.mtime !== mtime) cache = { mtime, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
        return cache.config;
    } catch { return {}; }
}
