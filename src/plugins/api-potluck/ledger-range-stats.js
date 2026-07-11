/**
 * API 大锅饭 - Ledger 区间预聚合
 * 从 permanent-usage-ledger/daily JSONL 流式聚合区间统计，
 * 为管理页提供 provider/账号/模型分布，替代全量现算路径。
 * 输出不包含任何 key 原文/哈希/前缀。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { DEFAULT_CONVERSION_MODEL, PRICING_VERSION, estimateUsageCost, normalizeConversionModel } from './cost-estimator.js';

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function createBucket() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0,
        cost: {
            actualUsd: 0,
            convertedUsd: 0,
            missingPriceTokens: 0
        }
    };
}

function addRowToBucket(bucket, row) {
    const usage = row.usage || {};
    const currentCost = estimateUsageCost(usage, row.model || 'unknown');
    bucket.requestCount += toNumber(usage.requestCount);
    bucket.promptTokens += toNumber(usage.promptTokens);
    bucket.completionTokens += toNumber(usage.completionTokens);
    bucket.totalTokens += toNumber(usage.totalTokens);
    bucket.cachedTokens += toNumber(usage.cachedTokens);
    bucket.cost.actualUsd += currentCost.usd;
    bucket.cost.missingPriceTokens += currentCost.missingPriceTokens;
}

function finalizeBucket(bucket, conversionModel) {
    bucket.cost.convertedUsd = estimateUsageCost({
        promptTokens: bucket.promptTokens,
        cachedTokens: bucket.cachedTokens,
        completionTokens: bucket.completionTokens,
        totalTokens: bucket.totalTokens
    }, conversionModel).usd;
    bucket.cost.conversionModel = conversionModel;
    bucket.cost.pricingVersion = PRICING_VERSION;
    return bucket;
}

function ensureAccount(accounts, row) {
    const name = row.accountKey || `${row.provider || 'unknown'}:unknown`;
    if (!accounts[name]) {
        accounts[name] = {
            provider: row.provider || 'unknown',
            providerUuid: row.accountIdentity || '',
            accountIdentity: row.accountIdentity || '',
            accountEmail: row.accountEmail || '',
            providerUuids: [],
            providerName: row.providerName || '',
            summary: createBucket(),
            models: {}
        };
    }
    const account = accounts[name];
    if (row.accountEmail && !account.accountEmail) account.accountEmail = row.accountEmail;
    if (row.providerName && !account.providerName) account.providerName = row.providerName;
    if (Array.isArray(row.providerUuids)) {
        account.providerUuids = [...new Set([...account.providerUuids, ...row.providerUuids].filter(Boolean))];
    }
    return account;
}

export function createLedgerRangeAggregator({ conversionModel = DEFAULT_CONVERSION_MODEL } = {}) {
    const normalizedConversionModel = normalizeConversionModel(conversionModel);
    const summary = createBucket();
    const providers = {};
    const models = {};
    const accounts = {};

    return {
        addRow(row) {
            if (!row || typeof row !== 'object') return;
            addRowToBucket(summary, row);

            const providerName = row.provider || 'unknown';
            if (!providers[providerName]) providers[providerName] = createBucket();
            addRowToBucket(providers[providerName], row);

            const modelName = row.model || 'unknown';
            if (!models[modelName]) models[modelName] = createBucket();
            addRowToBucket(models[modelName], row);

            const account = ensureAccount(accounts, row);
            addRowToBucket(account.summary, row);
            if (!account.models[modelName]) account.models[modelName] = createBucket();
            addRowToBucket(account.models[modelName], row);
        },
        result() {
            finalizeBucket(summary, normalizedConversionModel);
            for (const bucket of Object.values(providers)) finalizeBucket(bucket, normalizedConversionModel);
            for (const bucket of Object.values(models)) finalizeBucket(bucket, normalizedConversionModel);
            for (const account of Object.values(accounts)) {
                finalizeBucket(account.summary, normalizedConversionModel);
                for (const bucket of Object.values(account.models)) finalizeBucket(bucket, normalizedConversionModel);
            }
            return {
                summary,
                providers,
                models,
                accounts,
                conversionModel: normalizedConversionModel,
                pricingVersion: PRICING_VERSION
            };
        }
    };
}

async function addFileRows(aggregator, filePath) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            try {
                aggregator.addRow(JSON.parse(line));
            } catch {
                // Ignore corrupted partial lines.
            }
        }
    } finally {
        lines.close();
        input.destroy();
    }
}

export function listLedgerDates(ledgerDailyDir) {
    if (!fs.existsSync(ledgerDailyDir)) return [];
    return fs.readdirSync(ledgerDailyDir)
        .map(name => name.match(/^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
        .filter(Boolean)
        .sort();
}

/**
 * 读取并聚合指定日期集合的 ledger 日文件。
 * @returns {{availableDates: string[], missingDates: string[], summary, providers, models, accounts, conversionModel, pricingVersion}}
 */
export async function readLedgerRangeStats({ ledgerDailyDir, dates = [], conversionModel, now = new Date() } = {}) {
    const aggregator = createLedgerRangeAggregator({ conversionModel });
    const availableDates = [];
    const missingDates = [];
    const todayKey = getBeijingDateKey(now);

    for (const date of dates) {
        // 当天账本可能是凌晨 write 的静态快照，分布面板始终以实时 usageHistory 为准。
        if (date === todayKey) {
            missingDates.push(date);
            continue;
        }
        const filePath = path.join(ledgerDailyDir, `usage-${date}.jsonl`);
        if (!fs.existsSync(filePath)) {
            missingDates.push(date);
            continue;
        }
        await addFileRows(aggregator, filePath);
        availableDates.push(date);
    }

    return {
        availableDates,
        missingDates,
        ...aggregator.result()
    };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getBeijingDateKey(now = new Date()) {
    return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateKey(dateKey, deltaDays) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + deltaDays);
    return date.toISOString().slice(0, 10);
}

function dateKeysBetween(from, to) {
    const keys = [];
    for (let key = from; key <= to; key = shiftDateKey(key, 1)) keys.push(key);
    return keys;
}

/**
 * 将管理页的 range 参数换算为北京时间日期列表。
 * `total` 返回 ledger 目录里已有的全部日期加上今天。
 */
export function resolveRangeDates(range, { ledgerDailyDir, now = new Date() } = {}) {
    const todayKey = getBeijingDateKey(now);
    if (range === 'today') return [todayKey];
    if (range === '7d') return dateKeysBetween(shiftDateKey(todayKey, -6), todayKey);
    if (range === '30d') return dateKeysBetween(shiftDateKey(todayKey, -29), todayKey);
    const ledgerDates = listLedgerDates(ledgerDailyDir);
    return [...new Set([...ledgerDates, todayKey])].sort();
}
