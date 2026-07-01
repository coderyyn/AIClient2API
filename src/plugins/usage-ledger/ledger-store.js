import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

const DEFAULT_RETENTION_DAYS = 35;

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
}

function dateKey(value) {
    return toDate(value).toISOString().slice(0, 10);
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeFact(fact = {}) {
    const timestamp = toDate(fact.timestamp || new Date()).toISOString();
    return {
        schemaVersion: 1,
        timestamp,
        beijingDate: fact.beijingDate || null,
        requestId: fact.requestId || null,
        potluckKeyHash: fact.potluckKeyHash || null,
        potluckKeyId: fact.potluckKeyId || null,
        potluckKeyName: fact.potluckKeyName || null,
        provider: fact.provider || null,
        providerUuid: fact.providerUuid || null,
        accountEmail: fact.accountEmail || null,
        accountDisplay: fact.accountDisplay || null,
        requestedModel: fact.requestedModel || fact.actualModel || fact.model || null,
        actualModel: fact.actualModel || fact.model || fact.requestedModel || null,
        requestCount: toNumber(fact.requestCount) || 1,
        promptTokens: toNumber(fact.promptTokens ?? fact.inputTokens),
        cachedTokens: toNumber(fact.cachedTokens ?? fact.cachedInputTokens),
        completionTokens: toNumber(fact.completionTokens ?? fact.outputTokens),
        reasoningTokens: toNumber(fact.reasoningTokens),
        totalTokens: toNumber(fact.totalTokens),
        stream: Boolean(fact.stream),
        source: fact.source || 'runtime'
    };
}

function factIdentity(fact = {}) {
    const requestId = fact.requestId || '';
    const key = fact.potluckKeyHash || fact.potluckKeyId || 'no-potluck-key';
    return `${key}:${requestId || `no-request:${fact.timestamp || ''}`}`;
}

function mergeMaxFact(previous, next) {
    if (!previous) return next;
    return {
        ...previous,
        ...next,
        requestCount: Math.max(toNumber(previous.requestCount), toNumber(next.requestCount)),
        promptTokens: Math.max(toNumber(previous.promptTokens), toNumber(next.promptTokens)),
        cachedTokens: Math.max(toNumber(previous.cachedTokens), toNumber(next.cachedTokens)),
        completionTokens: Math.max(toNumber(previous.completionTokens), toNumber(next.completionTokens)),
        reasoningTokens: Math.max(toNumber(previous.reasoningTokens), toNumber(next.reasoningTokens)),
        totalTokens: Math.max(toNumber(previous.totalTokens), toNumber(next.totalTokens))
    };
}

function isLedgerFile(name) {
    return /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

function ledgerDateFromFile(filePath) {
    const match = path.basename(filePath).match(/^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    return match ? match[1] : null;
}

export class UsageLedgerStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'usage-ledger'),
        retentionDays = DEFAULT_RETENTION_DAYS
    } = {}) {
        this.dir = path.resolve(dir);
        this.retentionDays = Number(retentionDays) || DEFAULT_RETENTION_DAYS;
    }

    getFilePath(timestamp = new Date()) {
        return path.join(this.dir, `usage-${dateKey(timestamp)}.jsonl`);
    }

    async recordFact(fact = {}) {
        const [normalized] = await this.recordFacts([fact]);
        return normalized;
    }

    async recordFacts(facts = []) {
        const normalizedFacts = facts.map(fact => normalizeFact(fact));
        const byFile = new Map();
        for (const fact of normalizedFacts) {
            const filePath = this.getFilePath(fact.timestamp);
            if (!byFile.has(filePath)) byFile.set(filePath, []);
            byFile.get(filePath).push(fact);
        }

        for (const factsForDay of byFile.values()) {
            await this.rewriteDay(factsForDay[0].timestamp, rows => {
                const byId = new Map(rows.map(row => [factIdentity(row), row]));
                for (const normalized of factsForDay) {
                    const id = factIdentity(normalized);
                    byId.set(id, mergeMaxFact(byId.get(id), normalized));
                }
                return [...byId.values()].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
            });
        }

        const latestTimestamp = normalizedFacts
            .map(fact => toDate(fact.timestamp))
            .sort((a, b) => b.getTime() - a.getTime())[0];
        if (latestTimestamp) {
            await this.cleanup(latestTimestamp);
        }
        return normalizedFacts;
    }

    async replaceFacts(facts = []) {
        const normalizedFacts = facts.map(fact => normalizeFact(fact));
        const byFile = new Map();
        for (const fact of normalizedFacts) {
            const filePath = this.getFilePath(fact.timestamp);
            if (!byFile.has(filePath)) byFile.set(filePath, []);
            byFile.get(filePath).push(fact);
        }

        for (const factsForDay of byFile.values()) {
            await this.writeDayFacts(factsForDay[0].timestamp, factsForDay);
        }

        const latestTimestamp = normalizedFacts
            .map(fact => toDate(fact.timestamp))
            .sort((a, b) => b.getTime() - a.getTime())[0];
        if (latestTimestamp) {
            await this.cleanup(latestTimestamp);
        }
        return normalizedFacts;
    }

    async writeDayFacts(timestamp, facts = []) {
        await fsp.mkdir(this.dir, { recursive: true });
        const byId = new Map();
        for (const fact of facts) {
            const id = factIdentity(fact);
            byId.set(id, mergeMaxFact(byId.get(id), fact));
        }
        const nextRows = [...byId.values()]
            .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        const content = nextRows.map(row => JSON.stringify(row)).join('\n');
        await fsp.writeFile(this.getFilePath(timestamp), content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
    }

    async rewriteDay(timestamp, transform) {
        await fsp.mkdir(this.dir, { recursive: true });
        const filePath = this.getFilePath(timestamp);
        const rows = await this.readFile(filePath);
        const nextRows = transform(rows);
        const content = nextRows.map(row => JSON.stringify(row)).join('\n');
        await fsp.writeFile(filePath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
    }

    async readFile(filePath) {
        const content = await fsp.readFile(filePath, 'utf8').catch(() => '');
        const rows = [];
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line));
            } catch (_error) {
                // Skip corrupt lines rather than failing all reads.
            }
        }
        return rows;
    }

    async listFiles() {
        if (!fs.existsSync(this.dir)) return [];
        const entries = await fsp.readdir(this.dir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && isLedgerFile(entry.name))
            .map(entry => path.join(this.dir, entry.name))
            .sort();
    }

    async query(filters = {}) {
        const since = filters.since ? toDate(filters.since) : null;
        const until = filters.until ? toDate(filters.until) : null;
        const rows = [];
        for (const filePath of await this.listFiles()) {
            const fileDate = ledgerDateFromFile(filePath);
            if (since && fileDate && fileDate < dateKey(since)) continue;
            if (until && fileDate && fileDate > dateKey(until)) continue;
            for (const row of await this.readFile(filePath)) {
                const timestamp = toDate(row.timestamp);
                if (since && timestamp < since) continue;
                if (until && timestamp >= until) continue;
                if (filters.potluckKeyHash && row.potluckKeyHash !== filters.potluckKeyHash) continue;
                if (filters.providerUuid && row.providerUuid !== filters.providerUuid) continue;
                if (filters.accountEmail && row.accountEmail !== filters.accountEmail) continue;
                rows.push(row);
            }
        }
        return rows.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    }

    async cleanup(now = new Date()) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = toDate(now).getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
        for (const filePath of await this.listFiles()) {
            const match = path.basename(filePath).match(/^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/);
            const fileDate = match ? new Date(`${match[1]}T23:59:59.999Z`) : null;
            if (fileDate && fileDate.getTime() < cutoff) {
                await fsp.unlink(filePath).catch(() => {});
            }
        }
    }
}
