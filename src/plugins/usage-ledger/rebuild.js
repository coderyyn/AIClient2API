import { promises as fsp } from 'fs';
import path from 'path';

import { UsageLedgerStore } from './ledger-store.js';

const SUMMARY_FILE = 'usage-summary.json';

function isAuditFile(name) {
    return /^audit-\d{4}-\d{2}-\d{2}\.jsonl(?:\..+\.bak)?$/.test(name);
}

function auditDateFromFile(filePath) {
    const match = path.basename(filePath).match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl(?:\..+\.bak)?$/);
    return match ? match[1] : null;
}

function isCanonicalAuditFile(filePath) {
    return /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(path.basename(filePath));
}

function splitAccountKey(accountKey = '') {
    const separator = accountKey.indexOf(':');
    if (separator === -1) {
        return { provider: accountKey || null, accountEmail: null };
    }
    return {
        provider: accountKey.slice(0, separator) || null,
        accountEmail: accountKey.slice(separator + 1) || null
    };
}

function createBucket() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        lastUsedAt: null
    };
}

function addUsage(target, usage = {}) {
    target.requestCount += toNumber(usage.requestCount) || 1;
    target.promptTokens += toNumber(usage.promptTokens);
    target.completionTokens += toNumber(usage.completionTokens);
    target.reasoningTokens += toNumber(usage.reasoningTokens);
    target.totalTokens += toNumber(usage.totalTokens);
    target.cachedTokens += toNumber(usage.cachedTokens);
    if (usage.lastUsedAt && (!target.lastUsedAt || Date.parse(usage.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = usage.lastUsedAt;
    }
}

function ensureDay(history, date) {
    if (!history[date]) {
        history[date] = {
            summary: createBucket(),
            providers: {},
            models: {},
            accounts: {},
            hours: {}
        };
    }
    return history[date];
}

function ensureBucket(map, key) {
    const bucketKey = key || 'unknown';
    if (!map[bucketKey]) map[bucketKey] = createBucket();
    return map[bucketKey];
}

function ensureHour(day, hour) {
    if (!day.hours[hour]) {
        day.hours[hour] = {
            summary: createBucket(),
            providers: {},
            models: {},
            accounts: {}
        };
    }
    return day.hours[hour];
}

function beijingParts(timestamp) {
    const date = new Date(timestamp);
    const valid = Number.isFinite(date.getTime()) ? date : new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false
    }).formatToParts(valid);
    const value = type => parts.find(part => part.type === type)?.value;
    return {
        date: `${value('year')}-${value('month')}-${value('day')}`,
        hour: value('hour') || '00'
    };
}

function accountName(fact = {}) {
    if (fact.accountDisplay && !String(fact.accountDisplay).startsWith('redacted-email:')) {
        return fact.accountDisplay;
    }
    return fact.accountEmail || fact.accountDisplay || null;
}

function ensureAccount(map, fact = {}) {
    const provider = fact.provider || 'unknown';
    const providerName = accountName(fact);
    const identity = fact.accountEmail || fact.providerUuid || providerName;
    if (!identity) return null;
    const accountKey = `${provider}:${fact.accountEmail || identity}`;
    if (!map[accountKey]) {
        map[accountKey] = {
            provider,
            providerUuid: fact.accountEmail || identity,
            accountIdentity: fact.accountEmail || identity,
            accountEmail: fact.accountEmail || null,
            providerUuids: fact.providerUuid && fact.providerUuid !== fact.accountEmail ? [fact.providerUuid] : [],
            providerName,
            summary: createBucket(),
            models: {}
        };
    }
    return map[accountKey];
}

function factUsage(fact = {}) {
    return {
        requestCount: toNumber(fact.requestCount) || 1,
        promptTokens: toNumber(fact.promptTokens),
        cachedTokens: toNumber(fact.cachedTokens),
        completionTokens: toNumber(fact.completionTokens),
        reasoningTokens: toNumber(fact.reasoningTokens),
        totalTokens: toNumber(fact.totalTokens),
        lastUsedAt: fact.timestamp || null
    };
}

function factModel(fact = {}) {
    return fact.actualModel || fact.requestedModel || 'unknown';
}

function addFactToHistory(history, fact = {}) {
    const parts = beijingParts(fact.timestamp);
    const date = fact.beijingDate || parts.date;
    const hour = parts.hour;
    const provider = fact.provider || 'unknown';
    const model = factModel(fact);
    const usage = factUsage(fact);
    const day = ensureDay(history, date);

    addUsage(day.summary, usage);
    addUsage(ensureBucket(day.providers, provider), usage);
    addUsage(ensureBucket(day.models, model), usage);
    const account = ensureAccount(day.accounts, fact);
    if (account) {
        addUsage(account.summary, usage);
        addUsage(ensureBucket(account.models, model), usage);
    }

    const hourUsage = ensureHour(day, hour);
    addUsage(hourUsage.summary, usage);
    addUsage(ensureBucket(hourUsage.providers, provider), usage);
    addUsage(ensureBucket(hourUsage.models, model), usage);
    const hourAccount = ensureAccount(hourUsage.accounts, fact);
    if (hourAccount) {
        addUsage(hourAccount.summary, usage);
        addUsage(ensureBucket(hourAccount.models, model), usage);
    }
}

function createSummary() {
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        usageHistory: {},
        byKeyHash: {},
        totals: createBucket(),
        models: {}
    };
}

function addFactToSummary(summary, fact = {}) {
    const usage = factUsage(fact);
    const model = factModel(fact);
    addUsage(summary.totals, usage);
    addUsage(ensureBucket(summary.models, model), usage);
    addFactToHistory(summary.usageHistory, fact);

    if (!fact.potluckKeyHash) return;
    if (!summary.byKeyHash[fact.potluckKeyHash]) {
        summary.byKeyHash[fact.potluckKeyHash] = {
            usageHistory: {},
            totals: createBucket(),
            models: {}
        };
    }
    const keySummary = summary.byKeyHash[fact.potluckKeyHash];
    addUsage(keySummary.totals, usage);
    addUsage(ensureBucket(keySummary.models, model), usage);
    addFactToHistory(keySummary.usageHistory, fact);
}

async function writeSummary(ledgerDir, summary) {
    if (!ledgerDir) return;
    await fsp.mkdir(ledgerDir, { recursive: true });
    await fsp.writeFile(path.join(ledgerDir, SUMMARY_FILE), JSON.stringify({
        ...summary,
        generatedAt: new Date().toISOString()
    }), { encoding: 'utf8', mode: 0o600 });
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function hasTokenUsage(usage = {}) {
    return toNumber(usage.promptTokens ?? usage.inputTokens) > 0 ||
        toNumber(usage.cachedTokens ?? usage.cachedInputTokens) > 0 ||
        toNumber(usage.completionTokens ?? usage.outputTokens) > 0 ||
        toNumber(usage.reasoningTokens) > 0 ||
        toNumber(usage.totalTokens) > 0;
}

function isSuccessfulAuditEvent(event = {}) {
    const status = event.status || null;
    if (!status) return true;
    if (status.outcome && status.outcome !== 'success') return false;
    const httpStatus = toNumber(status.httpStatus);
    return !httpStatus || httpStatus < 400;
}

async function listAuditFiles(auditDir) {
    if (!auditDir) return [];
    const entries = await fsp.readdir(auditDir, { withFileTypes: true }).catch(() => []);
    const byDate = new Map();
    for (const filePath of entries
        .filter(entry => entry.isFile() && isAuditFile(entry.name))
        .map(entry => path.join(auditDir, entry.name))
        .sort()) {
        const date = auditDateFromFile(filePath);
        if (!date) continue;
        const current = byDate.get(date) || { canonical: null, backups: [] };
        if (isCanonicalAuditFile(filePath)) {
            current.canonical = filePath;
        } else {
            current.backups.push(filePath);
        }
        byDate.set(date, current);
    }
    return [...byDate.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, files]) => files.canonical || files.backups.sort().at(-1))
        .filter(Boolean);
}

async function readJsonl(filePath) {
    const content = await fsp.readFile(filePath, 'utf8').catch(() => '');
    const rows = [];
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            rows.push(JSON.parse(line));
        } catch (_error) {
            // Rebuild should keep going if one old audit line is corrupt.
        }
    }
    return rows;
}

function auditEventToFact(event = {}) {
    if (!isSuccessfulAuditEvent(event)) return null;
    const request = event.request || {};
    const usage = event.usage || {};
    if (!hasTokenUsage(usage)) return null;
    const potluckKey = event.potluckKey || {};
    const account = event.account || {};
    return {
        timestamp: event.timestamp,
        beijingDate: event.beijingDate || null,
        requestId: event.requestId || null,
        potluckKeyHash: potluckKey.hash || null,
        potluckKeyId: potluckKey.id || null,
        potluckKeyName: potluckKey.name || null,
        provider: request.toProvider || event.provider || null,
        providerUuid: account.providerUuid || null,
        accountEmail: account.email || null,
        accountDisplay: account.providerNameDisplay || account.displayName || null,
        requestedModel: request.requestedModel || request.model || null,
        actualModel: request.actualModel || request.model || request.requestedModel || null,
        promptTokens: toNumber(usage.promptTokens ?? usage.inputTokens),
        cachedTokens: toNumber(usage.cachedTokens ?? usage.cachedInputTokens),
        completionTokens: toNumber(usage.completionTokens ?? usage.outputTokens),
        reasoningTokens: toNumber(usage.reasoningTokens),
        totalTokens: toNumber(usage.totalTokens),
        stream: Boolean(request.stream ?? event.stream),
        source: 'request-audit'
    };
}

async function readModelUsageStats(modelUsagePath) {
    if (!modelUsagePath) return null;
    const content = await fsp.readFile(modelUsagePath, 'utf8').catch(() => null);
    if (!content) return null;
    try {
        return JSON.parse(content);
    } catch (_error) {
        return null;
    }
}

function modelUsageDailyToFacts(stats, coveredDates) {
    const facts = [];
    const daily = stats?.daily || {};
    for (const [date, dayStats] of Object.entries(daily)) {
        if (coveredDates.has(date)) continue;
        const accounts = dayStats?.accounts || {};
        for (const [accountKey, accountStats] of Object.entries(accounts)) {
            const { provider, accountEmail } = splitAccountKey(accountKey);
            const models = accountStats?.models || {};
            for (const [model, modelStats] of Object.entries(models)) {
                facts.push({
                    timestamp: `${date}T00:00:00.000Z`,
                    beijingDate: date,
                    requestId: `model-usage-stats:${date}:${accountKey}:${model}`,
                    potluckKeyHash: null,
                    provider,
                    accountEmail,
                    requestedModel: model,
                    actualModel: model,
                    requestCount: toNumber(modelStats.requestCount),
                    promptTokens: toNumber(modelStats.promptTokens ?? modelStats.inputTokens),
                    cachedTokens: toNumber(modelStats.cachedTokens ?? modelStats.cachedInputTokens),
                    completionTokens: toNumber(modelStats.completionTokens ?? modelStats.outputTokens),
                    reasoningTokens: toNumber(modelStats.reasoningTokens),
                    totalTokens: toNumber(modelStats.totalTokens),
                    source: 'model-usage-stats'
                });
            }
        }
    }
    return facts;
}

export async function rebuildUsageLedger({
    auditDir,
    ledgerDir,
    modelUsagePath,
    retentionDays = 35
} = {}) {
    const store = new UsageLedgerStore({ dir: ledgerDir, retentionDays });
    const auditFiles = await listAuditFiles(auditDir);
    const coveredDates = new Set(auditFiles.map(auditDateFromFile).filter(Boolean));
    const summary = createSummary();
    let auditFacts = 0;

    for (const filePath of auditFiles) {
        const factsForFile = [];
        for (const event of await readJsonl(filePath)) {
            const fact = auditEventToFact(event);
            if (!fact) continue;
            factsForFile.push(fact);
            addFactToSummary(summary, fact);
            auditFacts += 1;
        }
        await store.replaceFacts(factsForFile);
    }

    const stats = await readModelUsageStats(modelUsagePath);
    const fallbackFacts = modelUsageDailyToFacts(stats, coveredDates);
    for (const fact of fallbackFacts) {
        addFactToSummary(summary, fact);
    }
    await store.replaceFacts(fallbackFacts);
    await writeSummary(ledgerDir, summary);

    return {
        auditFacts,
        modelUsageFallbackFacts: fallbackFacts.length,
        coveredDates: [...coveredDates].sort()
    };
}
