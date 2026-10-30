import { resolveClientNetwork, signNetworkHeaders, readIngressNetworkConfig } from '../utils/client-network.js';
import http from 'http';
import { classifyRuntimeRequest } from './worker-topology.js';

export function createRuntimeProxyHandler({ controlTarget, executionTargets, onProxyError, getRuntimeStatus, isTargetReady, onTargetRequest, networkSecret, getNetworkConfig = readIngressNetworkConfig } = {}) {
    let executionIndex = 0;
    return (req, res) => {
        if (req.method === 'GET' && req.url.split('?')[0] === '/runtime/health' && getRuntimeStatus) {
            const status = getRuntimeStatus();
            res.writeHead(status.status === 'healthy' ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(status));
            return;
        }
        const role = classifyRuntimeRequest(req.method, req.url);
        const targetIndex = role === 'execution'
            ? executionIndex++ % executionTargets.length
            : null;
        const target = role === 'execution' ? executionTargets[targetIndex] : controlTarget;
        if (isTargetReady && !isTargetReady(role, targetIndex)) {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' });
            res.end(JSON.stringify({ error: { code: 'RUNTIME_WORKER_STARTING', message: 'Runtime worker is still starting' } }));
            return;
        }
        onTargetRequest?.(role, targetIndex, target);
        const network = resolveClientNetwork(req, getNetworkConfig(), { detailed: true });
        const deniedStatus=Number(req.headers['x-edge-denied-status']);
        if(network.clientIpSource.startsWith('trusted-') && [401,403,429,503].includes(deniedStatus)) network.edgeDeniedStatus=deniedStatus;
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !name.toLowerCase().startsWith('x-aiclient-network')));
        headers['x-real-ip'] = network.clientIp;
        headers['x-forwarded-for'] = network.clientIp;
        if (networkSecret) Object.assign(headers, signNetworkHeaders(networkSecret, req, network));
        const upstream = http.request({
            host: target.host,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: { ...headers, 'x-aiclient-runtime-role': role },
            agent: false
        }, upstreamResponse => {
            res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(res);
        });
        upstream.on('error', error => {
            onProxyError?.(error, { role, target });
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
            if (!res.writableEnded) res.end(JSON.stringify({ error: { code: 'RUNTIME_WORKER_UNAVAILABLE', message: 'Runtime worker unavailable' } }));
        });
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        req.pipe(upstream);
    };
}
