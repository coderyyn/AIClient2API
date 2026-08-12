import net from 'net';
import tls from 'tls';
import { createHash } from 'crypto';

function encodeCommand(parts) {
    const values = parts.map(part => Buffer.from(String(part)));
    const chunks = [Buffer.from(`*${values.length}\r\n`)];
    for (const value of values) chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
    return Buffer.concat(chunks);
}

function readLine(buffer, offset) {
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    return { value: buffer.toString('utf8', offset, end), next: end + 2 };
}

function parseResp(buffer, offset = 0) {
    if (offset >= buffer.length) return null;
    const prefix = String.fromCharCode(buffer[offset]);
    const line = readLine(buffer, offset + 1);
    if (!line) return null;
    if (prefix === '+') return { value: line.value, next: line.next };
    if (prefix === '-') {
        const error = new Error(line.value);
        error.redis = true;
        return { error, next: line.next };
    }
    if (prefix === ':') return { value: Number(line.value), next: line.next };
    if (prefix === '$') {
        const length = Number(line.value);
        if (length === -1) return { value: null, next: line.next };
        const end = line.next + length;
        if (buffer.length < end + 2) return null;
        return { value: buffer.toString('utf8', line.next, end), next: end + 2 };
    }
    if (prefix === '*') {
        const length = Number(line.value);
        if (length === -1) return { value: null, next: line.next };
        const values = [];
        let next = line.next;
        for (let index = 0; index < length; index++) {
            const parsed = parseResp(buffer, next);
            if (!parsed) return null;
            if (parsed.error) throw parsed.error;
            values.push(parsed.value);
            next = parsed.next;
        }
        return { value: values, next };
    }
    throw new Error(`Unsupported Redis response prefix: ${prefix}`);
}

export class RedisRespClient {
    constructor(options = {}) {
        this.host = options.host || '127.0.0.1';
        this.port = Number(options.port || 6379);
        this.password = options.password || null;
        this.database = Number(options.database || 0);
        this.useTls = options.tls === true;
        this.connectTimeoutMs = Number(options.connectTimeoutMs || 2000);
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.pending = [];
        this.connecting = null;
        this.scriptHashes = new Map();
    }

    async connect() {
        if (this.socket && !this.socket.destroyed) return;
        if (this.connecting) return this.connecting;
        this.connecting = new Promise((resolve, reject) => {
            const socket = this.useTls
                ? tls.connect({ host: this.host, port: this.port })
                : net.createConnection({ host: this.host, port: this.port });
            const timeout = setTimeout(() => socket.destroy(new Error('Redis connection timeout')), this.connectTimeoutMs);
            socket.setNoDelay(true);
            socket.on('data', chunk => this._onData(chunk));
            socket.on('error', error => this._failPending(error));
            socket.on('close', () => { if (this.socket === socket) this.socket = null; });
            socket.once(this.useTls ? 'secureConnect' : 'connect', async () => {
                clearTimeout(timeout);
                this.socket = socket;
                try {
                    if (this.password) await this.command(['AUTH', this.password], { skipConnect: true });
                    if (this.database) await this.command(['SELECT', this.database], { skipConnect: true });
                    resolve();
                } catch (error) {
                    socket.destroy();
                    reject(error);
                }
            });
        }).finally(() => { this.connecting = null; });
        return this.connecting;
    }

    _onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.pending.length > 0) {
            let parsed;
            try { parsed = parseResp(this.buffer); } catch (error) {
                const pending = this.pending.shift();
                pending.reject(error);
                this.buffer = Buffer.alloc(0);
                continue;
            }
            if (!parsed) break;
            this.buffer = this.buffer.subarray(parsed.next);
            const pending = this.pending.shift();
            if (parsed.error) pending.reject(parsed.error);
            else pending.resolve(parsed.value);
        }
    }

    _failPending(error) {
        while (this.pending.length) this.pending.shift().reject(error);
    }

    async command(parts, options = {}) {
        if (!options.skipConnect) await this.connect();
        if (!this.socket || this.socket.destroyed) throw new Error('Redis socket is unavailable');
        return new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject });
            this.socket.write(encodeCommand(parts), error => {
                if (!error) return;
                const index = this.pending.findIndex(item => item.resolve === resolve);
                if (index >= 0) this.pending.splice(index, 1);
                reject(error);
            });
        });
    }

    async evalScript(name, script, keys = [], args = []) {
        const hash = this.scriptHashes.get(name) || createHash('sha1').update(script).digest('hex');
        this.scriptHashes.set(name, hash);
        try {
            return await this.command(['EVALSHA', hash, keys.length, ...keys, ...args]);
        } catch (error) {
            if (!/NOSCRIPT/i.test(error.message)) throw error;
            return this.command(['EVAL', script, keys.length, ...keys, ...args]);
        }
    }

    async close() {
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.destroyed) return;
        await new Promise(resolve => {
            socket.once('close', resolve);
            socket.end();
        });
    }
}
