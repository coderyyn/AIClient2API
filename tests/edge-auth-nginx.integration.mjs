// Real Nginx boundary test. Requires Docker and a pre-pulled Nginx image.
// EDGE_AUTH_NGINX_TEST_IMAGE may select an existing local image; never pulls.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.EDGE_AUTH_NGINX_TEST_IMAGE || 'nginx:stable-alpine';
const docker = async (...args) => (await exec('docker', args, { timeout: 30000 })).stdout.trim();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-auth-nginx-'));
let container;
let upstreamCalls = 0;
let authCalls = 0;
let passed = 0;
const expectedRateError = {
    error: { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests. Please retry later.' }
};
const auth = http.createServer((req, res) => {
    authCalls++;
    const key = req.headers.authorization;
    if (key === 'Bearer synthetic-active') {
        res.writeHead(204, { 'x-edge-key-hash': 'synthetic-hash',
            'x-edge-lease-id': 'synthetic-lease', 'x-edge-lease-mode': 'enforce' });
    } else if (key === 'Bearer synthetic-limited') {
        res.writeHead(403, { 'x-edge-response-status': '429' });
    } else if (key === 'Bearer synthetic-wrong-marker') {
        res.writeHead(403, { 'x-edge-response-status': '4290' });
    } else if (key === 'Bearer synthetic-disabled') {
        res.writeHead(403);
    } else {
        res.writeHead(401);
    }
    res.end();
});
const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    const status = Number(req.headers['x-test-upstream-status']) || 200;
    res.writeHead(status, { 'content-type': 'application/json', 'x-edge-response-status': '429' });
    res.end(JSON.stringify({ status, lease: req.headers['x-edge-lease-id'], keyHash: req.headers['x-edge-key-hash'] }));
});
const listen = server => new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const close = server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
});

try {
    await Promise.all([listen(auth), listen(upstream)]);
    const api = await fs.readFile(path.join(root, 'docker/nginx-edge-auth-api-location.conf'), 'utf8');
    const location = (await fs.readFile(path.join(root, 'docker/nginx-edge-auth-location.conf'), 'utf8'))
        .replace('127.0.0.1:18081', `host.docker.internal:${auth.address().port}`);
    await fs.writeFile(path.join(temp, 'api.conf'), api);
    await fs.writeFile(path.join(temp, 'locations.conf'), location);
    const prefixes = ['/openai-codex-oauth/v1/', '/gemini-antigravity/v1/', '/v1/', '/gemini-antigravity/v1beta/'];
    const protectedLocation = prefix => `location ^~ ${prefix} {
        include /test/api.conf;
        proxy_pass http://host.docker.internal:${upstream.address().port};
    }`;
    await fs.writeFile(path.join(temp, 'nginx.conf'), `
worker_processes 1;
pid /tmp/edge-auth-nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 128; }
http {
    access_log off;
    proxy_headers_hash_max_size 1024;
    proxy_headers_hash_bucket_size 128;
    limit_req_zone $binary_remote_addr zone=integration_ip:1m rate=1r/m;
    server {
        listen 8080;
        include /test/locations.conf;
        ${prefixes.map(protectedLocation).join('\n')}
        location /ip-limit/ {
            include /test/api.conf;
            limit_req zone=integration_ip;
            limit_req_status 429;
            proxy_pass http://host.docker.internal:${upstream.address().port};
        }
        location / { return 404; }
    }
}
`);
    const mount = `type=bind,source=${temp},target=/test,readonly`;
    const preflight = await docker('run', '--rm', '--pull=never', '--mount', mount,
        '--entrypoint', 'nginx', image, '-t', '-c', '/test/nginx.conf');
    console.log('nginx -t passed', preflight);
    container = await docker('run', '-d', '--rm', '--pull=never', '--mount', mount,
        '-p', '127.0.0.1::8080', '--entrypoint', 'nginx', image,
        '-c', '/test/nginx.conf', '-g', 'daemon off;');
    const address = await docker('port', container, '8080/tcp');
    const origin = `http://${address}`;
    const request = async (uri, key = 'synthetic-active', headers = {}) => {
        const response = await fetch(origin + uri, { method: 'POST',
            headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
            body: '{}', signal: AbortSignal.timeout(5000) });
        return { status: response.status, headers: response.headers, body: await response.text() };
    };
    // Wait for the short-lived test container, with a bounded readiness loop.
    for (let attempt = 0; ; attempt++) {
        try { await request('/ready'); break; }
        catch (error) {
            if (attempt >= 30) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    for (const prefix of prefixes) {
        const uri = `${prefix}chat/completions`;
        const before = upstreamCalls;
        const beforeAuth = authCalls;
        const limited = await request(uri, 'synthetic-limited');
        assert.equal(limited.status, 429);
        assert.match(limited.headers.get('content-type'), /application\/json/);
        assert.deepEqual(JSON.parse(limited.body), expectedRateError);
        assert.equal(limited.headers.get('x-edge-response-status'), null);
        assert.equal(limited.headers.get('retry-after'), null);
        assert.equal(upstreamCalls, before);
        assert.equal(authCalls, beforeAuth + 1, 'no recursive authorization');
        passed++;
        for (const [key, status] of [['synthetic-disabled', 403], ['synthetic-wrong-marker', 403], ['', 401], ['synthetic-invalid', 401]]) {
            const denied = await request(uri, key, { 'x-edge-response-status': '429' });
            assert.equal(denied.status, status, 'client cannot forge the internal rate marker');
            assert.equal(upstreamCalls, before);
            if (status === 403) assert.match(denied.body, /403 Forbidden/);
            passed++;
        }
        for (const status of [200, 403, 429, 503]) {
            const forwarded = await request(uri, 'synthetic-active', {
                'x-test-upstream-status': String(status), 'x-edge-lease-id': 'forged', 'x-edge-key-hash': 'forged'
            });
            assert.equal(forwarded.status, status);
            assert.deepEqual(JSON.parse(forwarded.body), { status, lease: 'synthetic-lease', keyHash: 'synthetic-hash' });
            assert.equal(forwarded.headers.get('x-edge-response-status'), null);
            passed++;
        }
    }
    const beforeInternal = authCalls;
    assert.equal((await request('/_edge_auth')).status, 404);
    assert.equal((await request('/@edge_auth_denied')).status, 404);
    assert.equal(authCalls, beforeInternal);
    passed += 2;
    assert.equal((await request('/ip-limit/test')).status, 200);
    const beforeIp = upstreamCalls;
    assert.equal((await request('/ip-limit/test')).status, 429);
    assert.equal(upstreamCalls, beforeIp);
    passed += 2;
    console.log(`PASS: ${passed} real Nginx boundary checks (${image})`);
} catch (error) {
    if (container) console.error((await exec('docker', ['logs', container])).stderr);
    throw error;
} finally {
    // Only remove the container and directory created by this test invocation.
    if (container) await docker('stop', '-t', '2', container);
    await Promise.all([close(auth), close(upstream)]);
    // Windows temp cleanup is explicit in PowerShell, scoped to this fresh path.
    if (process.platform === 'win32') {
        assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temp).startsWith('edge-auth-nginx-'));
        const escaped = temp.replaceAll("'", "''");
        await exec('powershell.exe', ['-NoProfile', '-Command',
            `Remove-Item -LiteralPath '${escaped}' -Recurse; if (Test-Path -LiteralPath '${escaped}') { throw 'Test directory cleanup failed' }`]);
    } else {
        await fs.rm(temp, { recursive: true });
    }
}
