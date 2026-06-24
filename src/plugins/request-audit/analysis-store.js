import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

function dateKeyFromTimestamp(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function isAnalysisFile(name) {
    return /^analysis-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

export class RequestAuditAnalysisStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'request-audit-analysis'),
        freshSeconds = 5 * 60
    } = {}) {
        this.dir = dir;
        this.freshSeconds = Number(freshSeconds) || 300;
    }

    getFilePath(timestamp = new Date()) {
        return path.join(this.dir, `analysis-${dateKeyFromTimestamp(timestamp)}.jsonl`);
    }

    getLatestPath() {
        return path.join(this.dir, 'latest.json');
    }

    async writeDiagnostics(diagnostics = [], { generatedAt = new Date().toISOString() } = {}) {
        await fsp.mkdir(this.dir, { recursive: true });
        const filePath = this.getFilePath(generatedAt);
        const content = diagnostics
            .filter(item => item?.requestId)
            .map(item => JSON.stringify({ ...item, generatedAt }))
            .join('\n');
        await fsp.writeFile(filePath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
        await fsp.writeFile(this.getLatestPath(), JSON.stringify({
            generatedAt,
            count: diagnostics.length
        }, null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    async readDiagnostics({ requestIds = [] } = {}) {
        if (!fs.existsSync(this.dir)) return {};
        const wanted = new Set(requestIds.filter(Boolean));
        const files = await this.listFiles();
        const result = {};

        for (const filePath of files) {
            const content = await fsp.readFile(filePath, 'utf8').catch(() => '');
            for (const line of content.split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    const item = JSON.parse(line);
                    if (!item.requestId) continue;
                    if (wanted.size > 0 && !wanted.has(item.requestId)) continue;
                    result[item.requestId] = item;
                } catch (_error) {
                    // Ignore malformed materialized analysis rows.
                }
            }
        }
        return result;
    }

    async readFreshness(now = new Date()) {
        const latestPath = this.getLatestPath();
        if (!fs.existsSync(latestPath)) {
            return { status: 'missing', generatedAt: null, staleSeconds: null };
        }
        try {
            const latest = JSON.parse(await fsp.readFile(latestPath, 'utf8'));
            const generatedAt = latest.generatedAt || null;
            const generatedTime = generatedAt ? new Date(generatedAt).getTime() : NaN;
            if (!Number.isFinite(generatedTime)) {
                return { status: 'missing', generatedAt: null, staleSeconds: null };
            }
            const staleSeconds = Math.max(0, Math.floor((now.getTime() - generatedTime) / 1000));
            return {
                generatedAt,
                staleSeconds,
                status: staleSeconds <= this.freshSeconds ? 'fresh' : 'stale'
            };
        } catch (_error) {
            return { status: 'missing', generatedAt: null, staleSeconds: null };
        }
    }

    async listFiles() {
        if (!fs.existsSync(this.dir)) return [];
        const entries = await fsp.readdir(this.dir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && isAnalysisFile(entry.name))
            .map(entry => path.join(this.dir, entry.name))
            .sort();
    }
}
