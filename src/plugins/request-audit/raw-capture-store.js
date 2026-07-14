import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
}

function dateKey(value) {
    return toDate(value).toISOString().slice(0, 10);
}

function safeRequestId(value) {
    return String(value || `request-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function normalizeKeyHashes(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    return [];
}

export function shouldCaptureRawRequest(options = {}, event = {}) {
    if (options.enabled !== true && options.enabled !== 'true') return false;
    const keyHashes = normalizeKeyHashes(options.keyHashes);
    if (keyHashes.length === 0) return false;
    return keyHashes.includes(event?.potluckKey?.hash);
}

export class RequestAuditRawCaptureStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'request-audit-raw'),
        ttlMinutes = 60,
        maxBytes = 1024 * 1024
    } = {}) {
        this.dir = path.resolve(dir);
        this.ttlMinutes = Number(ttlMinutes) || 60;
        this.maxBytes = Number(maxBytes) || 1024 * 1024;
    }

    updateOptions({ ttlMinutes, maxBytes } = {}) {
        if (Number(ttlMinutes) > 0) this.ttlMinutes = Number(ttlMinutes);
        if (Number(maxBytes) > 0) this.maxBytes = Number(maxBytes);
    }

    getFilePath(event = {}) {
        const filePath = path.resolve(this.dir, dateKey(event.timestamp), `${safeRequestId(event.requestId)}.json.gz`);
        if (!filePath.startsWith(this.dir)) {
            throw new Error('Raw capture path escaped configured directory');
        }
        return filePath;
    }

    async capture(event = {}) {
        const filePath = this.getFilePath(event);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const payload = {
            schemaVersion: 1,
            requestId: event.requestId || null,
            timestamp: event.timestamp || new Date().toISOString(),
            potluckKeyHash: event.potluckKey?.hash || null,
            request: event.request || null,
            originalRequestBody: event.originalRequestBody || null,
            processedRequestBody: event.processedRequestBody || null
        };
        let serialized = JSON.stringify(payload);
        let truncated = false;
        if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
            serialized = serialized.slice(0, this.maxBytes);
            truncated = true;
        }
        const wrapped = JSON.stringify({
            truncated,
            payload: serialized
        });
        const compressed = await gzip(wrapped);
        await fsp.writeFile(filePath, compressed, { mode: 0o600 });
        const eventDate = toDate(event.timestamp);
        await fsp.utimes(filePath, eventDate, eventDate).catch(() => {});
        return { captured: true, path: filePath, truncated };
    }

    async cleanup(now = new Date()) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = toDate(now).getTime() - this.ttlMinutes * 60 * 1000;
        const removeExpired = async dir => {
            const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await removeExpired(fullPath);
                    await fsp.rmdir(fullPath).catch(() => {});
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith('.json.gz')) continue;
                const stat = await fsp.stat(fullPath).catch(() => null);
                if (stat && stat.mtime.getTime() < cutoff) {
                    await fsp.unlink(fullPath).catch(() => {});
                }
            }
        };
        await removeExpired(this.dir);
    }

    async countFiles() {
        if (!fs.existsSync(this.dir)) return 0;
        let count = 0;
        const walk = async dir => {
            const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.json.gz')) {
                    count += 1;
                }
            }
        };
        await walk(this.dir);
        return count;
    }
}
