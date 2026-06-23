import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function dateKeyFromTimestamp(value) {
    const date = toDate(value) || new Date();
    return date.toISOString().slice(0, 10);
}

function isAuditFile(name) {
    return /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

export class RequestAuditStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'request-audit'),
        retentionHours = 24,
        maxFileBytes = 100 * 1024 * 1024
    } = {}) {
        this.dir = dir;
        this.retentionHours = Number(retentionHours) || 24;
        this.maxFileBytes = Number(maxFileBytes) || 100 * 1024 * 1024;
    }

    getFilePath(timestamp = new Date()) {
        return path.join(this.dir, `audit-${dateKeyFromTimestamp(timestamp)}.jsonl`);
    }

    async append(event) {
        await fsp.mkdir(this.dir, { recursive: true });
        const filePath = this.getFilePath(event?.timestamp);
        await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    async query(filters = {}) {
        const since = toDate(filters.since);
        const until = toDate(filters.until);
        const files = await this.listFiles();
        const rows = [];

        for (const filePath of files) {
            const content = await fsp.readFile(filePath, 'utf8').catch(() => '');
            for (const line of content.split(/\r?\n/)) {
                if (!line.trim()) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch (_error) {
                    continue;
                }
                if (!this.matches(event, { ...filters, since, until })) continue;
                rows.push(event);
            }
        }

        rows.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        const limit = Math.min(Math.max(Number(filters.limit) || rows.length, 0), 2000);
        return limit ? rows.slice(0, limit) : rows;
    }

    matches(event, filters) {
        const timestamp = toDate(event?.timestamp);
        if (filters.since && timestamp && timestamp < filters.since) return false;
        if (filters.until && timestamp && timestamp >= filters.until) return false;
        if (filters.keyHash && event?.potluckKey?.hash !== filters.keyHash) return false;
        if (filters.keyPrefix && event?.potluckKey?.prefix !== filters.keyPrefix) return false;
        if (filters.requestId && event?.requestId !== filters.requestId) return false;
        if (filters.model && event?.request?.model !== filters.model) return false;
        if (filters.provider && event?.request?.toProvider !== filters.provider) return false;
        if (filters.outcome && event?.status?.outcome !== filters.outcome) return false;
        return true;
    }

    async listFiles() {
        if (!fs.existsSync(this.dir)) return [];
        const entries = await fsp.readdir(this.dir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && isAuditFile(entry.name))
            .map(entry => path.join(this.dir, entry.name))
            .sort();
    }

    async cleanup(now = new Date()) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = toDate(now).getTime() - this.retentionHours * 60 * 60 * 1000;
        const files = await this.listFiles();
        for (const filePath of files) {
            const match = path.basename(filePath).match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
            const fileDate = match ? new Date(`${match[1]}T23:59:59.999Z`) : null;
            if (fileDate && fileDate.getTime() < cutoff) {
                await fsp.unlink(filePath).catch(() => {});
            }
        }
    }
}
