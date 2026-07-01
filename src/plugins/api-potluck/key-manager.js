/**
 * API 大锅饭 - Key 管理模块
 * 使用内存缓存 + 写锁 + 定期持久化，解决并发安全问题
 */

import { atomicWriteFile, atomicWriteFileSync } from '../../utils/file-lock.js';
import { promises as fs } from 'fs';
import logger from '../../utils/logger.js';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { RateManager } from '../../utils/rate-tracker.js';
import { getBeijingDateString } from '../../utils/common.js';
import { hashSecret, sanitizeProviderName } from '../request-audit/audit-event.js';
import { UsageLedgerStore } from '../usage-ledger/ledger-store.js';
import {
    DEFAULT_CONVERSION_MODEL,
    buildCost,
    getConversionModels,
    normalizeConversionModel
} from './cost-estimator.js';

// 配置文件路径
const KEYS_STORE_FILE = path.join(process.cwd(), 'configs', 'api-potluck-keys.json');
const MODEL_USAGE_STATS_FILE = path.join(process.cwd(), 'configs', 'model-usage-stats.json');

const KEY_PREFIX = 'maki_';
const USAGE_HISTORY_RETENTION_DAYS = 35;
const USAGE_LEDGER_SNAPSHOT_CACHE_TTL_MS = 60 * 1000;
const USAGE_LEDGER_SUMMARY_FILE = 'usage-summary.json';

const DEFAULT_CONFIG = {
    persistInterval: 5000,
    defaultDailyLimit: 500
};

let configGetter = null;

/**
 * 设置配置获取器
 */
export function setConfigGetter(getter) {
    configGetter = getter;
}

/**
 * 获取当前配置
 */
function getConfig() {
    if (configGetter) {
        return configGetter();
    }
    return DEFAULT_CONFIG;
}

/**
 * 获取今日日期字符串
 */
function getTodayDateString() {
    return getBeijingDateString();
}

// 插件状态
let keyStore = null;
let isDirty = false;
let isWriting = false;
let persistTimer = null;
let currentPersistInterval = DEFAULT_CONFIG.persistInterval;
let usageLedgerStore = null;
let usageLedgerSnapshotCache = null;

const rateManager = new RateManager(60);

function getUsageLedgerStore() {
    if (!usageLedgerStore) {
        usageLedgerStore = new UsageLedgerStore();
    }
    return usageLedgerStore;
}

function createUsageBucket() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0,
        lastUsedAt: null
    };
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeUsageBucket(bucket) {
    if (typeof bucket === 'number') {
        return {
            ...createUsageBucket(),
            requestCount: bucket
        };
    }

    return {
        ...createUsageBucket(),
        ...(bucket || {}),
        requestCount: toNumber(bucket?.requestCount),
        promptTokens: toNumber(bucket?.promptTokens),
        completionTokens: toNumber(bucket?.completionTokens),
        reasoningTokens: toNumber(bucket?.reasoningTokens),
        totalTokens: toNumber(bucket?.totalTokens),
        cachedTokens: toNumber(bucket?.cachedTokens),
        maxQps: toNumber(bucket?.maxQps),
        maxRpm: toNumber(bucket?.maxRpm),
        maxTps: toNumber(bucket?.maxTps),
        lastUsedAt: bucket?.lastUsedAt || null
    };
}

function normalizeUsageMap(map = {}) {
    const normalized = {};
    for (const [name, usage] of Object.entries(map || {})) {
        normalized[name] = normalizeUsageBucket(usage);
    }
    return normalized;
}

function normalizeAccountUsageMap(map = {}) {
    const normalized = {};
    for (const [accountKey, account] of Object.entries(map || {})) {
        const providerUuid = account?.providerUuid || accountKey.split(':').slice(1).join(':') || null;
        normalized[accountKey] = {
            provider: account?.provider || accountKey.split(':')[0] || 'unknown',
            providerUuid,
            accountIdentity: account?.accountIdentity || null,
            accountEmail: account?.accountEmail || null,
            providerUuids: Array.isArray(account?.providerUuids)
                ? [...new Set(account.providerUuids.filter(Boolean))]
                : (providerUuid ? [providerUuid] : []),
            providerName: account?.providerName || null,
            summary: normalizeUsageBucket(account?.summary),
            models: normalizeUsageMap(account?.models)
        };
    }
    return normalized;
}

function normalizeHourlyUsageMap(map = {}) {
    const normalized = {};
    for (const [hour, hourData] of Object.entries(map || {})) {
        normalized[hour] = {
            summary: normalizeUsageBucket(hourData?.summary),
            providers: normalizeUsageMap(hourData?.providers),
            models: normalizeUsageMap(hourData?.models),
            accounts: normalizeAccountUsageMap(hourData?.accounts)
        };
    }
    return normalized;
}

function normalizeUsageHistoryDay(day = {}) {
    return {
        summary: normalizeUsageBucket(day.summary || {
            requestCount: day.requestCount
        }),
        providers: normalizeUsageMap(day.providers),
        models: normalizeUsageMap(day.models),
        accounts: normalizeAccountUsageMap(day.accounts),
        hours: normalizeHourlyUsageMap(day.hours)
    };
}

function addCacheHitRatio(bucket) {
    if (!bucket || typeof bucket !== 'object') return bucket;
    const promptTokens = toNumber(bucket.promptTokens);
    bucket.cacheHitRatio = promptTokens > 0 ? toNumber(bucket.cachedTokens) / promptTokens : 0;
    return bucket;
}

function addUsageHistoryRatios(usageHistory = {}) {
    for (const day of Object.values(usageHistory || {})) {
        addCacheHitRatio(day.summary);
        for (const usage of Object.values(day.providers || {})) {
            addCacheHitRatio(usage);
        }
        for (const usage of Object.values(day.models || {})) {
            addCacheHitRatio(usage);
        }
        for (const account of Object.values(day.accounts || {})) {
            addCacheHitRatio(account.summary);
            for (const usage of Object.values(account.models || {})) {
                addCacheHitRatio(usage);
            }
        }
        for (const hour of Object.values(day.hours || {})) {
            addCacheHitRatio(hour.summary);
            for (const usage of Object.values(hour.providers || {})) {
                addCacheHitRatio(usage);
            }
            for (const usage of Object.values(hour.models || {})) {
                addCacheHitRatio(usage);
            }
            for (const account of Object.values(hour.accounts || {})) {
                addCacheHitRatio(account.summary);
                for (const usage of Object.values(account.models || {})) {
                    addCacheHitRatio(usage);
                }
            }
        }
    }
    return usageHistory;
}

function normalizeKeyData(keyData = {}) {
    const normalized = {
        ...keyData,
        todayUsage: toNumber(keyData.todayUsage),
        totalUsage: toNumber(keyData.totalUsage),
        todayPromptTokens: toNumber(keyData.todayPromptTokens),
        todayCompletionTokens: toNumber(keyData.todayCompletionTokens),
        todayReasoningTokens: toNumber(keyData.todayReasoningTokens),
        todayTotalTokens: toNumber(keyData.todayTotalTokens),
        todayCachedTokens: toNumber(keyData.todayCachedTokens),
        totalPromptTokens: toNumber(keyData.totalPromptTokens),
        totalCompletionTokens: toNumber(keyData.totalCompletionTokens),
        totalReasoningTokens: toNumber(keyData.totalReasoningTokens),
        totalTokens: toNumber(keyData.totalTokens),
        totalCachedTokens: toNumber(keyData.totalCachedTokens),
        totalModels: normalizeUsageMap(keyData.totalModels),
        usageHistory: {}
    };

    for (const [date, day] of Object.entries(keyData.usageHistory || {})) {
        normalized.usageHistory[date] = normalizeUsageHistoryDay(day);
    }

    if (Object.keys(normalized.totalModels).length === 0) {
        normalized.totalModels = collectModelsFromUsageHistory(normalized.usageHistory);
    }

    trimUsageHistory(normalized.usageHistory, USAGE_HISTORY_RETENTION_DAYS);

    return normalized;
}

function trimUsageHistory(usageHistory = {}, retentionDays = USAGE_HISTORY_RETENTION_DAYS) {
    const dates = Object.keys(usageHistory || {}).sort();
    if (dates.length <= retentionDays) return usageHistory;
    for (const date of dates.slice(0, dates.length - retentionDays)) {
        delete usageHistory[date];
    }
    return usageHistory;
}

function normalizeStore(store = {}) {
    const normalized = { keys: {} };
    for (const [keyId, keyData] of Object.entries(store.keys || {})) {
        normalized.keys[keyId] = normalizeKeyData(keyData);
    }
    return normalized;
}

function addUsage(target, usage = {}) {
    // 默认请求数为 1，确保总量与明细一致
    const rCount = usage.requestCount !== undefined ? toNumber(usage.requestCount) : 1;
    target.requestCount += rCount;
    target.promptTokens += toNumber(usage.promptTokens);
    target.completionTokens += toNumber(usage.completionTokens);
    target.reasoningTokens += toNumber(usage.reasoningTokens);
    target.totalTokens += toNumber(usage.totalTokens);
    target.cachedTokens += toNumber(usage.cachedTokens);
    
    // 聚合峰值：使用累加还是最大值取决于上下文。
    // 在汇总多个 Key 的历史数据时，累加可能更能代表系统总峰值（假设可能同时发生）
    // 但更准确的是记录全局 RateTracker 的峰值。
    // 这里简单处理：如果 usage 中有峰值，则取最大值或累加。
    // 鉴于这是日历展示，我们取最大值以展示该日达到的最高单项或汇总峰值。
    target.maxQps = Math.max(target.maxQps || 0, toNumber(usage.maxQps));
    target.maxRpm = Math.max(target.maxRpm || 0, toNumber(usage.maxRpm));
    target.maxTps = Math.max(target.maxTps || 0, toNumber(usage.maxTps));
    if (usage.lastUsedAt && (!target.lastUsedAt || Date.parse(usage.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = usage.lastUsedAt;
    }
}

function latestTimestamp(current, candidate) {
    if (!candidate) return current || null;
    if (!current) return candidate;
    const currentMs = Date.parse(current);
    const candidateMs = Date.parse(candidate);
    if (!Number.isFinite(candidateMs)) return current;
    if (!Number.isFinite(currentMs)) return candidate;
    return candidateMs > currentMs ? candidate : current;
}

function isCodexEmailAccountProvider(provider) {
    return provider === 'openai-codex-oauth' || provider === 'openaiResponses-custom';
}

function getCanonicalAccountUsageIdentity(provider, providerUuid, accountIdentity = null, accountEmail = null, providerName = null) {
    if (isCodexEmailAccountProvider(provider)) {
        const email = normalizeEmailAlias(accountEmail) || normalizeEmailAlias(accountIdentity) || normalizeEmailAlias(providerName);
        if (!email) return null;
        return {
            provider: 'openai-codex-oauth',
            identity: email,
            accountEmail: email
        };
    }

    const identity = accountIdentity || providerUuid;
    if (!provider || !identity) return null;
    return {
        provider,
        identity,
        accountEmail: normalizeEmailAlias(accountEmail)
    };
}

function getAccountUsageKey(provider, providerUuid, accountIdentity = null, accountEmail = null, providerName = null) {
    const canonical = getCanonicalAccountUsageIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!canonical?.provider || !canonical?.identity) return null;
    return `${canonical.provider}:${canonical.identity}`;
}

function addProviderUuidToAccount(accountUsage, providerUuid) {
    if (!accountUsage || !providerUuid) return;
    const existing = Array.isArray(accountUsage.providerUuids) ? accountUsage.providerUuids : [];
    accountUsage.providerUuids = [...new Set([...existing, providerUuid].filter(Boolean))];
}

function ensureAccountUsage(map, provider, providerUuid, providerName, accountIdentity = null, accountEmail = null) {
    const accountKey = getAccountUsageKey(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!accountKey) return null;
    const canonical = getCanonicalAccountUsageIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);

    if (!map[accountKey]) {
        map[accountKey] = {
            provider: canonical.provider,
            providerUuid: canonical.identity,
            accountIdentity: canonical.identity || null,
            accountEmail: canonical.accountEmail || null,
            providerUuids: providerUuid ? [providerUuid] : [],
            providerName: providerName || null,
            summary: createUsageBucket(),
            models: {}
        };
    } else {
        if (canonical?.identity) {
            map[accountKey].provider = canonical.provider;
            map[accountKey].accountIdentity = canonical.identity;
            map[accountKey].providerUuid = canonical.identity;
        }
        if (canonical?.accountEmail) {
            map[accountKey].accountEmail = canonical.accountEmail;
        }
        addProviderUuidToAccount(map[accountKey], providerUuid);
        if (providerName && !map[accountKey].providerName) {
            map[accountKey].providerName = providerName;
        }
    }

    return map[accountKey];
}

function getBeijingHourString(timestamp = new Date()) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hour12: false
    }).formatToParts(date);
    return parts.find(part => part.type === 'hour')?.value || '00';
}

function ensureHourUsage(dayHistory, hour) {
    if (!dayHistory.hours[hour]) {
        dayHistory.hours[hour] = {
            summary: createUsageBucket(),
            providers: {},
            models: {},
            accounts: {}
        };
    }
    return dayHistory.hours[hour];
}

function addAccountUsage(targetMap, account = {}) {
    const provider = account.provider || 'unknown';
    const providerUuids = Array.isArray(account.providerUuids)
        ? account.providerUuids.filter(Boolean)
        : [];
    const providerUuid = providerUuids[0] || account.providerUuid || null;
    const accountUsage = ensureAccountUsage(targetMap, provider, providerUuid, account.providerName, account.accountIdentity || null, account.accountEmail || null);
    if (!accountUsage) return;
    if (account.accountEmail && !accountUsage.accountEmail) {
        accountUsage.accountEmail = account.accountEmail;
    }
    for (const uuid of providerUuids) {
        addProviderUuidToAccount(accountUsage, uuid);
    }
    if (account.providerUuid && account.providerUuid !== account.accountIdentity) {
        addProviderUuidToAccount(accountUsage, account.providerUuid);
    }

    addUsage(accountUsage.summary, account.summary);
    for (const [model, usage] of Object.entries(account.models || {})) {
        accountUsage.models[model] = normalizeUsageBucket(accountUsage.models[model]);
        addUsage(accountUsage.models[model], usage);
    }
}

function getBeijingDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const getPart = (type) => Number(parts.find(part => part.type === type)?.value);
    return {
        year: getPart('year'),
        month: getPart('month'),
        day: getPart('day')
    };
}

function dateKeyFromUtcDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getBeijingPeriodStarts(now = new Date()) {
    const parts = getBeijingDateParts(now);
    const todayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const weekStartUtc = new Date(todayUtc);
    weekStartUtc.setUTCDate(todayUtc.getUTCDate() - 6);
    const monthStartUtc = new Date(todayUtc);
    monthStartUtc.setUTCDate(todayUtc.getUTCDate() - 29);

    return {
        today: dateKeyFromUtcDate(todayUtc),
        week: dateKeyFromUtcDate(weekStartUtc),
        month: dateKeyFromUtcDate(monthStartUtc)
    };
}

function cloneUsageBucket(bucket = {}) {
    const normalized = normalizeUsageBucket(bucket);
    if (bucket?.cost) {
        normalized.cost = cloneCostBucket(bucket.cost);
    }
    return normalized;
}

function createCostBucket(sourceCost = {}) {
    return {
        actualUsd: 0,
        convertedUsd: 0,
        missingPriceTokens: 0,
        conversionModel: sourceCost.conversionModel || DEFAULT_CONVERSION_MODEL,
        pricingVersion: sourceCost.pricingVersion || '',
        byModel: {}
    };
}

function cloneCostBucket(cost = {}) {
    return {
        ...createCostBucket(cost),
        ...cost,
        actualUsd: toNumber(cost.actualUsd),
        convertedUsd: toNumber(cost.convertedUsd),
        missingPriceTokens: toNumber(cost.missingPriceTokens),
        byModel: { ...(cost.byModel || {}) }
    };
}

function addCost(targetUsage, sourceCost = null) {
    if (!sourceCost) return;
    if (!targetUsage.cost) targetUsage.cost = createCostBucket(sourceCost);
    targetUsage.cost.actualUsd += toNumber(sourceCost.actualUsd);
    targetUsage.cost.convertedUsd += toNumber(sourceCost.convertedUsd);
    targetUsage.cost.missingPriceTokens += toNumber(sourceCost.missingPriceTokens);
    targetUsage.cost.conversionModel = sourceCost.conversionModel || targetUsage.cost.conversionModel;
    targetUsage.cost.pricingVersion = sourceCost.pricingVersion || targetUsage.cost.pricingVersion;
    for (const [model, estimate] of Object.entries(sourceCost.byModel || {})) {
        const current = targetUsage.cost.byModel[model] || {};
        targetUsage.cost.byModel[model] = {
            ...estimate,
            usd: toNumber(current.usd) + toNumber(estimate.usd),
            missingPriceTokens: toNumber(current.missingPriceTokens) + toNumber(estimate.missingPriceTokens)
        };
    }
}

function addAccountSummaryRange(target, rangeName, account) {
    if (!target[rangeName]) target[rangeName] = createUsageBucket();
    addUsage(target[rangeName], account?.summary);
    addCost(target[rangeName], account?.summary?.cost);
}

function isEmailLike(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeEmailAlias(value) {
    return isEmailLike(value) ? value.trim().toLowerCase() : null;
}

function normalizeDisplayAlias(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase().replace(/\s+/g, '');
    if (!normalized || normalized.startsWith('redacted-email:')) return null;
    return normalized;
}

function getProviderFromAccountKey(accountKey) {
    return accountKey?.split(':')[0] || 'unknown';
}

function getIdentityFromAccountKey(accountKey) {
    return accountKey?.split(':').slice(1).join(':') || null;
}

function getAccountProvider(accountKey, account = {}) {
    return account.provider || getProviderFromAccountKey(accountKey);
}

function getSummaryCanonicalAccountKey(accountKey, account = {}) {
    const provider = getAccountProvider(accountKey, account);
    return getAccountUsageKey(
        provider,
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    ) || accountKey;
}

function getAccountSummaryAliases(accountKey, account = {}) {
    const provider = getAccountProvider(accountKey, account);
    const aliases = new Set([`account-key:${accountKey}`]);
    const addProviderAlias = (value) => {
        if (value) aliases.add(`provider:${provider}:${value}`);
    };

    addProviderAlias(getIdentityFromAccountKey(accountKey));
    addProviderAlias(account.providerUuid);
    addProviderAlias(account.accountIdentity);
    for (const uuid of account.providerUuids || []) {
        addProviderAlias(uuid);
    }

    const emailAlias = normalizeEmailAlias(account.accountEmail) || normalizeEmailAlias(account.providerName);
    if (emailAlias) {
        aliases.add(`email:${provider}:${emailAlias}`);
    }
    for (const value of [
        getIdentityFromAccountKey(accountKey),
        account.providerUuid,
        account.accountIdentity,
        account.providerName
    ]) {
        const displayAlias = normalizeDisplayAlias(value);
        if (displayAlias) aliases.add(`display:${provider}:${displayAlias}`);
    }

    return [...aliases];
}

function createAccountSummaryEntry(accountKey, account = {}) {
    const provider = getAccountProvider(accountKey, account);
    const canonical = getCanonicalAccountUsageIdentity(
        provider,
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    );
    const providerUuid = canonical?.identity
        || account.accountIdentity
        || account.providerUuid
        || getIdentityFromAccountKey(accountKey);
    const providerUuids = Array.isArray(account.providerUuids)
        ? [...new Set(account.providerUuids.filter(Boolean))]
        : (account.providerUuid && account.providerUuid !== account.accountIdentity ? [account.providerUuid] : []);

    return {
        accountKey: getSummaryCanonicalAccountKey(accountKey, account),
        provider: canonical?.provider || provider,
        providerUuid,
        accountIdentity: canonical?.identity || account.accountIdentity || null,
        accountEmail: canonical?.accountEmail || account.accountEmail || normalizeEmailAlias(account.providerName),
        providerUuids,
        providerName: account.providerName || null,
        today: createUsageBucket(),
        week: createUsageBucket(),
        month: createUsageBucket()
    };
}

function mergeAccountSummaryMeta(target, account = {}, accountKey = null) {
    if (!target) return;
    const canonical = getCanonicalAccountUsageIdentity(
        account.provider || target.provider || getProviderFromAccountKey(accountKey),
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    );
    if (canonical?.provider) {
        target.provider = canonical.provider;
    }
    if (canonical?.identity) {
        target.accountIdentity = canonical.identity;
        target.providerUuid = canonical.identity;
    }
    if (canonical?.accountEmail) {
        target.accountEmail = canonical.accountEmail;
    }
    if (account.providerName && (!target.providerName || String(target.providerName).startsWith('redacted-email:'))) {
        target.providerName = account.providerName;
    }
    if (account.accountEmail && !target.accountEmail) {
        target.accountEmail = account.accountEmail;
    } else if (!target.accountEmail && normalizeEmailAlias(account.providerName)) {
        target.accountEmail = normalizeEmailAlias(account.providerName);
    }
    if (account.accountIdentity && !target.accountIdentity) {
        target.accountIdentity = account.accountIdentity;
        target.providerUuid = account.accountIdentity;
    }

    const uuids = new Set(Array.isArray(target.providerUuids) ? target.providerUuids : []);
    for (const uuid of account.providerUuids || []) {
        if (uuid && uuid !== target.accountIdentity) uuids.add(uuid);
    }
    if (account.providerUuid && account.providerUuid !== target.accountIdentity) {
        uuids.add(account.providerUuid);
    }
    const keyIdentity = getIdentityFromAccountKey(accountKey);
    if (keyIdentity && keyIdentity !== target.accountIdentity) {
        uuids.add(keyIdentity);
    }
    target.providerUuids = [...uuids];
}

function reassignAccountSummaryAliases(aliasIndex, fromKey, toKey) {
    for (const [alias, key] of aliasIndex.entries()) {
        if (key === fromKey) {
            aliasIndex.set(alias, toKey);
        }
    }
}

function getLatestUsageTimestampFromAccount(account = {}) {
    let latest = account?.summary?.lastUsedAt || account?.lastUsedAt || null;
    for (const usage of Object.values(account?.models || {})) {
        latest = latestTimestamp(latest, usage?.lastUsedAt);
    }
    return latest;
}

function readModelUsageAccountLastUsedIndex() {
    const index = new Map();
    if (!existsSync(MODEL_USAGE_STATS_FILE)) return index;

    try {
        const stats = JSON.parse(readFileSync(MODEL_USAGE_STATS_FILE, 'utf8'));
        for (const [accountKey, account] of Object.entries(stats.accounts || {})) {
            const lastUsedAt = getLatestUsageTimestampFromAccount(account);
            if (!lastUsedAt) continue;
            for (const alias of getAccountSummaryAliases(accountKey, account)) {
                index.set(alias, latestTimestamp(index.get(alias), lastUsedAt));
            }
        }
    } catch (error) {
        logger.warn(`[API Potluck] Failed to read model usage account timestamps: ${error.message}`);
    }

    return index;
}

function readModelUsageDailyHistory(conversionModel = DEFAULT_CONVERSION_MODEL) {
    if (!existsSync(MODEL_USAGE_STATS_FILE)) return null;

    try {
        const stats = JSON.parse(readFileSync(MODEL_USAGE_STATS_FILE, 'utf8'));
        const daily = stats.daily || {};
        const usageHistory = {};
        let hasAccountUsage = false;

        for (const [dateKey, day] of Object.entries(daily)) {
            const normalizedDay = normalizeUsageHistoryDay({
                summary: day,
                models: day?.models || {},
                accounts: day?.accounts || {}
            });
            if (Object.keys(normalizedDay.accounts || {}).length > 0) {
                hasAccountUsage = true;
            }
            usageHistory[dateKey] = normalizedDay;
        }

        if (!hasAccountUsage) return null;
        trimUsageHistory(usageHistory, USAGE_HISTORY_RETENTION_DAYS);
        addUsageHistoryRatios(usageHistory);
        addCostToUsageHistory(usageHistory, conversionModel);
        return usageHistory;
    } catch (error) {
        logger.warn(`[API Potluck] Failed to read model usage daily account history: ${error.message}`);
        return null;
    }
}

function getIndexedAccountLastUsedAt(account, lastUsedIndex) {
    let latest = null;
    for (const alias of getAccountSummaryAliases(account.accountKey, account)) {
        latest = latestTimestamp(latest, lastUsedIndex.get(alias));
    }
    return latest;
}

function resetUsageBucketTokens(bucket) {
    if (!bucket || typeof bucket !== 'object') return;
    bucket.promptTokens = 0;
    bucket.completionTokens = 0;
    bucket.reasoningTokens = 0;
    bucket.totalTokens = 0;
    bucket.cachedTokens = 0;
    bucket.maxQps = 0;
    bucket.maxRpm = 0;
    bucket.maxTps = 0;
}

function resetUsageHistoryTokens(usageHistory) {
    if (!usageHistory || typeof usageHistory !== 'object') return;

    for (const day of Object.values(usageHistory)) {
        if (!day || typeof day !== 'object') continue;
        resetUsageBucketTokens(day.summary);

        for (const usage of Object.values(day.providers || {})) {
            resetUsageBucketTokens(usage);
        }

        for (const usage of Object.values(day.models || {})) {
            resetUsageBucketTokens(usage);
        }

        for (const account of Object.values(day.accounts || {})) {
            resetUsageBucketTokens(account.summary);
            for (const usage of Object.values(account.models || {})) {
                resetUsageBucketTokens(usage);
            }
        }

        for (const hour of Object.values(day.hours || {})) {
            resetUsageBucketTokens(hour.summary);
            for (const usage of Object.values(hour.providers || {})) {
                resetUsageBucketTokens(usage);
            }
            for (const usage of Object.values(hour.models || {})) {
                resetUsageBucketTokens(usage);
            }
            for (const account of Object.values(hour.accounts || {})) {
                resetUsageBucketTokens(account.summary);
                for (const usage of Object.values(account.models || {})) {
                    resetUsageBucketTokens(usage);
                }
            }
        }
    }
}

function getRecentDateKeys(days = 7, now = new Date()) {
    const parts = getBeijingDateParts(now);
    const todayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const dateKeys = [];
    for (let offset = days - 1; offset >= 0; offset--) {
        const date = new Date(todayUtc);
        date.setUTCDate(todayUtc.getUTCDate() - offset);
        dateKeys.push(dateKeyFromUtcDate(date));
    }
    return dateKeys;
}

function getRecentHistorySummary(usageHistory = {}, days = 7, now = new Date()) {
    const summary = createUsageBucket();
    for (const date of getRecentDateKeys(days, now)) {
        const daySummary = usageHistory[date]?.summary;
        if (daySummary) addUsage(summary, daySummary);
    }
    addCacheHitRatio(summary);
    return summary;
}

function collectRelatedAccountNames(usageHistory = {}, limit = 2) {
    const accounts = new Map();
    const collectAccount = (account, dateKey = '') => {
        if (!account || typeof account !== 'object') return;
        const displayName = sanitizeProviderName(account.providerName) || account.providerUuid || account.provider;
        if (!displayName) return;

        const accountKey = `${account.provider || ''}:${account.providerUuid || displayName}`;
        const current = accounts.get(accountKey) || {
            name: displayName,
            requestCount: 0,
            totalTokens: 0,
            latestDate: ''
        };
        current.name = current.name || displayName;
        current.requestCount += toNumber(account.summary?.requestCount);
        current.totalTokens += toNumber(account.summary?.totalTokens);
        current.latestDate = current.latestDate > dateKey ? current.latestDate : dateKey;
        accounts.set(accountKey, current);
    };

    for (const [dateKey, day] of Object.entries(usageHistory || {})) {
        for (const account of Object.values(day?.accounts || {})) {
            collectAccount(account, dateKey);
        }
        for (const [hourKey, hour] of Object.entries(day?.hours || {})) {
            for (const account of Object.values(hour?.accounts || {})) {
                collectAccount(account, `${dateKey}T${hourKey}`);
            }
        }
    }

    return [...accounts.values()]
        .sort((a, b) => (
            b.requestCount - a.requestCount ||
            b.totalTokens - a.totalTokens ||
            b.latestDate.localeCompare(a.latestDate) ||
            a.name.localeCompare(b.name)
        ))
        .slice(0, limit)
        .map(account => account.name);
}

function collectModelsFromUsageHistory(usageHistory = {}) {
    const models = {};
    for (const day of Object.values(usageHistory || {})) {
        for (const [model, usage] of Object.entries(day?.models || {})) {
            models[model] = normalizeUsageBucket(models[model]);
            addUsage(models[model], usage);
        }
    }
    return models;
}

function addCostToUsageHistory(usageHistory = {}, conversionModel = DEFAULT_CONVERSION_MODEL) {
    for (const day of Object.values(usageHistory || {})) {
        if (!day?.summary) continue;
        day.summary.cost = buildCost(day.summary, day.models || {}, conversionModel);
        for (const [model, usage] of Object.entries(day.models || {})) {
            usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
        }
        for (const account of Object.values(day.accounts || {})) {
            account.summary.cost = buildCost(account.summary, account.models || {}, conversionModel);
            for (const [model, usage] of Object.entries(account.models || {})) {
                usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
            }
        }
        for (const hour of Object.values(day.hours || {})) {
            hour.summary.cost = buildCost(hour.summary, hour.models || {}, conversionModel);
            for (const [model, usage] of Object.entries(hour.models || {})) {
                usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
            }
            for (const account of Object.values(hour.accounts || {})) {
                account.summary.cost = buildCost(account.summary, account.models || {}, conversionModel);
                for (const [model, usage] of Object.entries(account.models || {})) {
                    usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
                }
            }
        }
    }
    return usageHistory;
}

function getBeijingDateHourParts(timestamp = new Date()) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const validDate = Number.isFinite(date.getTime()) ? date : new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false
    }).formatToParts(validDate);
    const value = type => parts.find(part => part.type === type)?.value;
    return {
        date: `${value('year')}-${value('month')}-${value('day')}`,
        hour: value('hour') || '00'
    };
}

function getLedgerFactModel(fact = {}) {
    return fact.actualModel || fact.requestedModel || 'unknown';
}

function getLedgerFactUsage(fact = {}) {
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

function hasLedgerFactTokenUsage(fact = {}) {
    return toNumber(fact.promptTokens) > 0 ||
        toNumber(fact.cachedTokens) > 0 ||
        toNumber(fact.completionTokens) > 0 ||
        toNumber(fact.reasoningTokens) > 0 ||
        toNumber(fact.totalTokens) > 0;
}

function getLedgerAccountProviderName(fact = {}) {
    if (fact.accountDisplay && !String(fact.accountDisplay).startsWith('redacted-email:')) {
        return fact.accountDisplay;
    }
    return fact.accountEmail || fact.accountDisplay || null;
}

function ensureLedgerFactAccountUsage(map, fact = {}) {
    const provider = fact.provider || 'unknown';
    const providerUuid = fact.providerUuid || fact.accountEmail || null;
    const providerName = getLedgerAccountProviderName(fact);
    const accountUsage = ensureAccountUsage(
        map,
        provider,
        providerUuid,
        providerName,
        fact.accountEmail || null,
        fact.accountEmail || null
    );
    if (accountUsage) return accountUsage;

    const identity = providerUuid || providerName;
    if (!identity) return null;
    const accountKey = `${provider}:${identity}`;
    if (!map[accountKey]) {
        map[accountKey] = {
            provider,
            providerUuid: identity,
            accountIdentity: providerUuid || null,
            accountEmail: fact.accountEmail || null,
            providerUuids: providerUuid ? [providerUuid] : [],
            providerName,
            summary: createUsageBucket(),
            models: {}
        };
    }
    return map[accountKey];
}

function addLedgerFactToHistory(usageHistory, fact = {}) {
    const { date, hour } = getBeijingDateHourParts(fact.timestamp);
    const dateKey = fact.beijingDate || date;
    if (!usageHistory[dateKey]) {
        usageHistory[dateKey] = normalizeUsageHistoryDay();
    }

    const day = usageHistory[dateKey];
    const usage = getLedgerFactUsage(fact);
    const provider = fact.provider || 'unknown';
    const model = getLedgerFactModel(fact);

    addUsage(day.summary, usage);
    day.providers[provider] = normalizeUsageBucket(day.providers[provider]);
    addUsage(day.providers[provider], usage);
    day.models[model] = normalizeUsageBucket(day.models[model]);
    addUsage(day.models[model], usage);

    const accountUsage = ensureLedgerFactAccountUsage(day.accounts, fact);
    if (accountUsage) {
        addUsage(accountUsage.summary, usage);
        accountUsage.models[model] = normalizeUsageBucket(accountUsage.models[model]);
        addUsage(accountUsage.models[model], usage);
    }

    const hourUsage = ensureHourUsage(day, hour);
    addUsage(hourUsage.summary, usage);
    hourUsage.providers[provider] = normalizeUsageBucket(hourUsage.providers[provider]);
    addUsage(hourUsage.providers[provider], usage);
    hourUsage.models[model] = normalizeUsageBucket(hourUsage.models[model]);
    addUsage(hourUsage.models[model], usage);
    const hourAccountUsage = ensureLedgerFactAccountUsage(hourUsage.accounts, fact);
    if (hourAccountUsage) {
        addUsage(hourAccountUsage.summary, usage);
        hourAccountUsage.models[model] = normalizeUsageBucket(hourAccountUsage.models[model]);
        addUsage(hourAccountUsage.models[model], usage);
    }
}

function createLedgerSnapshot(conversionModel = DEFAULT_CONVERSION_MODEL) {
    return {
        usageHistory: {},
        byKeyHash: new Map(),
        totals: createUsageBucket(),
        models: {}
    };
}

function getLedgerKeySnapshot(snapshot, keyHash) {
    if (!snapshot.byKeyHash.has(keyHash)) {
        snapshot.byKeyHash.set(keyHash, {
            usageHistory: {},
            totals: createUsageBucket(),
            models: {}
        });
    }
    return snapshot.byKeyHash.get(keyHash);
}

function addLedgerFactToSnapshot(snapshot, fact = {}) {
    if (!hasLedgerFactTokenUsage(fact)) return;
    const usage = getLedgerFactUsage(fact);
    const model = getLedgerFactModel(fact);
    addUsage(snapshot.totals, usage);
    snapshot.models[model] = normalizeUsageBucket(snapshot.models[model]);
    addUsage(snapshot.models[model], usage);
    addLedgerFactToHistory(snapshot.usageHistory, fact);

    if (!fact.potluckKeyHash) return;
    const keySnapshot = getLedgerKeySnapshot(snapshot, fact.potluckKeyHash);
    addUsage(keySnapshot.totals, usage);
    keySnapshot.models[model] = normalizeUsageBucket(keySnapshot.models[model]);
    addUsage(keySnapshot.models[model], usage);
    addLedgerFactToHistory(keySnapshot.usageHistory, fact);
}

function finalizeLedgerUsageHistory(usageHistory, conversionModel) {
    trimUsageHistory(usageHistory, USAGE_HISTORY_RETENTION_DAYS);
    addUsageHistoryRatios(usageHistory);
    addCostToUsageHistory(usageHistory, conversionModel);
    return usageHistory;
}

async function readLedgerUsageSnapshot(options = {}) {
    const { conversionModel } = getCostOptions(options);
    if (
        usageLedgerSnapshotCache?.conversionModel === conversionModel &&
        Date.now() - usageLedgerSnapshotCache.createdAt < USAGE_LEDGER_SNAPSHOT_CACHE_TTL_MS
    ) {
        return usageLedgerSnapshotCache.snapshot;
    }

    const store = getUsageLedgerStore();
    const summarySnapshot = await readLedgerSummarySnapshot(store, conversionModel);
    if (summarySnapshot) return summarySnapshot;

    const files = await store.listFiles().catch(error => {
        logger.warn(`[API Potluck] Failed to list usage ledger files: ${error.message}`);
        return [];
    });
    if (!files.length) return null;

    const fileStats = await Promise.all(files.map(async filePath => {
        const stat = await fs.stat(filePath).catch(() => null);
        return stat ? `${filePath}:${stat.size}:${stat.mtimeMs}` : `${filePath}:missing`;
    }));
    const signature = `${conversionModel}|${fileStats.join('|')}`;
    if (usageLedgerSnapshotCache?.signature === signature) {
        usageLedgerSnapshotCache.createdAt = Date.now();
        return usageLedgerSnapshotCache.snapshot;
    }

    let facts = [];
    try {
        facts = await store.query();
    } catch (error) {
        logger.warn(`[API Potluck] Failed to read usage ledger: ${error.message}`);
        return null;
    }
    if (!facts.length) return null;

    const snapshot = createLedgerSnapshot(conversionModel);
    for (const fact of facts) {
        addLedgerFactToSnapshot(snapshot, fact);
    }

    finalizeLedgerUsageHistory(snapshot.usageHistory, conversionModel);
    for (const keySnapshot of snapshot.byKeyHash.values()) {
        finalizeLedgerUsageHistory(keySnapshot.usageHistory, conversionModel);
    }
    usageLedgerSnapshotCache = { signature, conversionModel, createdAt: Date.now(), snapshot };
    return snapshot;
}

async function readLedgerSummarySnapshot(store, conversionModel) {
    const summaryPath = path.join(store.dir, USAGE_LEDGER_SUMMARY_FILE);
    const summaryStat = await fs.stat(summaryPath).catch(() => null);
    if (!summaryStat) return null;

    const signature = `${conversionModel}|${summaryPath}:${summaryStat.size}:${summaryStat.mtimeMs}`;
    let summary;
    try {
        summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    } catch (error) {
        logger.warn(`[API Potluck] Failed to read usage ledger summary: ${error.message}`);
        return null;
    }

    const snapshot = {
        usageHistory: summary.usageHistory || {},
        byKeyHash: new Map(Object.entries(summary.byKeyHash || {})),
        totals: normalizeUsageBucket(summary.totals),
        models: normalizeUsageMap(summary.models || {})
    };

    const incrementalFacts = summary.generatedAt
        ? await store.query({ since: summary.generatedAt }).catch(error => {
            logger.warn(`[API Potluck] Failed to read usage ledger increments: ${error.message}`);
            return [];
        })
        : [];
    for (const fact of incrementalFacts) {
        addLedgerFactToSnapshot(snapshot, fact);
    }

    finalizeLedgerUsageHistory(snapshot.usageHistory, conversionModel);
    for (const keySnapshot of snapshot.byKeyHash.values()) {
        finalizeLedgerUsageHistory(keySnapshot.usageHistory, conversionModel);
    }
    usageLedgerSnapshotCache = { signature, conversionModel, createdAt: Date.now(), snapshot };
    return snapshot;
}

function getUsageHistoryTotals(usageHistory = {}) {
    const totals = createUsageBucket();
    const models = {};
    for (const day of Object.values(usageHistory || {})) {
        addUsage(totals, day?.summary);
        for (const [model, usage] of Object.entries(day?.models || {})) {
            models[model] = normalizeUsageBucket(models[model]);
            addUsage(models[model], usage);
        }
    }
    return { totals, models };
}

function cloneUsageHistoryWithCosts(usageHistory = {}, conversionModel = DEFAULT_CONVERSION_MODEL) {
    const cloned = JSON.parse(JSON.stringify(usageHistory || {}));
    addUsageHistoryRatios(cloned);
    addCostToUsageHistory(cloned, conversionModel);
    return cloned;
}

function cloneUsageHistorySummaryOnly(usageHistory = {}, conversionModel = DEFAULT_CONVERSION_MODEL) {
    const compact = {};
    for (const [date, day] of Object.entries(usageHistory || {})) {
        const summary = cloneUsageBucket(day?.summary);
        addCacheHitRatio(summary);
        if (!summary.cost) {
            summary.cost = buildCost(summary, day?.models || {}, conversionModel);
        }
        compact[date] = { summary };
    }
    return compact;
}

function mergeKeyUsageHistory({
    ledgerUsageHistory = null,
    legacyUsageHistory = {},
    conversionModel = DEFAULT_CONVERSION_MODEL,
    summaryOnly = false
} = {}) {
    const usageHistory = summaryOnly
        ? cloneUsageHistorySummaryOnly(ledgerUsageHistory || {}, conversionModel)
        : (ledgerUsageHistory ? JSON.parse(JSON.stringify(ledgerUsageHistory)) : {});
    const legacyHistory = summaryOnly
        ? cloneUsageHistorySummaryOnly(legacyUsageHistory || {}, conversionModel)
        : cloneUsageHistoryWithCosts(legacyUsageHistory || {}, conversionModel);

    for (const [date, day] of Object.entries(legacyHistory || {})) {
        if (!usageHistory[date]) usageHistory[date] = day;
    }

    trimUsageHistory(usageHistory, USAGE_HISTORY_RETENTION_DAYS);
    addUsageHistoryRatios(usageHistory);
    return usageHistory;
}

function hasUsageTotals(usage = {}) {
    return toNumber(usage.requestCount) > 0 ||
        toNumber(usage.promptTokens) > 0 ||
        toNumber(usage.completionTokens) > 0 ||
        toNumber(usage.reasoningTokens) > 0 ||
        toNumber(usage.totalTokens) > 0 ||
        toNumber(usage.cachedTokens) > 0;
}

function getCostOptions(options = {}) {
    return {
        conversionModel: normalizeConversionModel(options?.conversionModel)
    };
}

function enrichKeyUsage(keyData, options = {}) {
    const { conversionModel } = getCostOptions(options);
    const ledgerUsageHistory = options.ledgerUsageHistory || null;
    const usageHistory = mergeKeyUsageHistory({
        ledgerUsageHistory,
        legacyUsageHistory: keyData.usageHistory || {},
        conversionModel,
        summaryOnly: Boolean(options.summaryOnly)
    });
    const weeklySummary = getRecentHistorySummary(usageHistory, 7);
    const historyTotals = getUsageHistoryTotals(usageHistory);
    const todaySummary = usageHistory[getTodayDateString()]?.summary || null;
    const cumulativeUsage = hasUsageTotals({
        requestCount: keyData.totalUsage,
        promptTokens: keyData.totalPromptTokens,
        cachedTokens: keyData.totalCachedTokens,
        completionTokens: keyData.totalCompletionTokens,
        reasoningTokens: keyData.totalReasoningTokens,
        totalTokens: keyData.totalTokens
    })
        ? {
            promptTokens: keyData.totalPromptTokens,
            cachedTokens: keyData.totalCachedTokens,
            completionTokens: keyData.totalCompletionTokens,
            reasoningTokens: keyData.totalReasoningTokens,
            totalTokens: keyData.totalTokens
        }
        : historyTotals.totals;
    const cumulativeModels = Object.keys(keyData.totalModels || {}).length > 0
        ? keyData.totalModels
        : (options.ledgerModels && Object.keys(options.ledgerModels || {}).length > 0)
            ? options.ledgerModels
        : historyTotals.models;
    const keyHash = hashSecret(keyData.id);
    const enriched = {
        ...keyData,
        todayUsage: todaySummary ? toNumber(todaySummary.requestCount) : keyData.todayUsage,
        todayPromptTokens: todaySummary ? toNumber(todaySummary.promptTokens) : keyData.todayPromptTokens,
        todayCompletionTokens: todaySummary ? toNumber(todaySummary.completionTokens) : keyData.todayCompletionTokens,
        todayReasoningTokens: todaySummary ? toNumber(todaySummary.reasoningTokens) : keyData.todayReasoningTokens,
        todayTotalTokens: todaySummary ? toNumber(todaySummary.totalTokens) : keyData.todayTotalTokens,
        todayCachedTokens: todaySummary ? toNumber(todaySummary.cachedTokens) : keyData.todayCachedTokens,
        usageHistory,
        cost: buildCost(
            cumulativeUsage,
            cumulativeModels,
            conversionModel
        ),
        pricing: {
            conversionModels: getConversionModels()
        },
        audit: {
            keyHash,
            summaryPath: `/api/request-audit/summary?keyHash=${encodeURIComponent(keyHash || '')}`,
            requestsPath: `/api/request-audit/requests?keyHash=${encodeURIComponent(keyHash || '')}`,
            defaultWindow: 'last20m',
            relatedNames: collectRelatedAccountNames(usageHistory)
        },
        weeklyUsage: weeklySummary.requestCount,
        weeklyPromptTokens: weeklySummary.promptTokens,
        weeklyCompletionTokens: weeklySummary.completionTokens,
        weeklyReasoningTokens: weeklySummary.reasoningTokens,
        weeklyTotalTokens: weeklySummary.totalTokens,
        weeklyCachedTokens: weeklySummary.cachedTokens,
        todayCacheHitRatio: todaySummary
            ? todaySummary.cacheHitRatio
            : (keyData.todayPromptTokens > 0 ? keyData.todayCachedTokens / keyData.todayPromptTokens : 0),
        weeklyCacheHitRatio: weeklySummary.cacheHitRatio,
        totalCacheHitRatio: keyData.totalPromptTokens > 0 ? keyData.totalCachedTokens / keyData.totalPromptTokens : 0
    };
    return enriched;
}

/**
 * 初始化：从文件加载数据到内存
 */
function ensureLoaded() {
    if (keyStore !== null) return;
    try {
        if (existsSync(KEYS_STORE_FILE)) {
            const content = readFileSync(KEYS_STORE_FILE, 'utf8');
            keyStore = normalizeStore(JSON.parse(content));
        } else {
            keyStore = { keys: {} };
            syncWriteToFile();
        }
    } catch (error) {
        logger.error('[API Potluck] Failed to load key store:', error.message);
        keyStore = { keys: {} };
    }
    
    // 获取配置的持久化间隔
    const config = getConfig();
    currentPersistInterval = config.persistInterval || DEFAULT_CONFIG.persistInterval;
    
    // 启动定期持久化
    if (!persistTimer) {
        persistTimer = setInterval(persistIfDirty, currentPersistInterval);
        if (persistTimer.unref) {
            persistTimer.unref();
        }
        // 进程退出时保存
        process.on('beforeExit', () => persistIfDirty());
        process.on('SIGINT', () => { persistIfDirty(); process.exit(0); });
        process.on('SIGTERM', () => { persistIfDirty(); process.exit(0); });
    }
}

/**
 * 同步写入文件（仅初始化时使用）
 */
function syncWriteToFile() {
    try {
        const dir = path.dirname(KEYS_STORE_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        atomicWriteFileSync(KEYS_STORE_FILE, JSON.stringify(keyStore, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
        logger.error('[API Potluck] Sync write failed:', error.message);
    }
}

/**
 * 异步持久化（带写锁）
 */
async function persistIfDirty() {
    if (!isDirty || isWriting || keyStore === null) return;
    isWriting = true;
    try {
        const dir = path.dirname(KEYS_STORE_FILE);
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }
        // 写入临时文件再重命名，并确保刷盘
        await atomicWriteFile(KEYS_STORE_FILE, JSON.stringify(keyStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        isDirty = false;
    } catch (error) {
        logger.error('[API Potluck] Persist failed:', error.message);
    } finally {
        isWriting = false;
    }
}

/**
 * 标记数据已修改
 */
function markDirty() {
    isDirty = true;
}

/**
 * 生成随机 API Key（确保不重复）
 */
function generateApiKey() {
    ensureLoaded();
    let apiKey;
    let attempts = 0;
    const maxAttempts = 10;
    
    do {
        apiKey = `${KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
        attempts++;
        if (attempts >= maxAttempts) {
            throw new Error('Failed to generate unique API key after multiple attempts');
        }
    } while (keyStore.keys[apiKey]);
    
    return apiKey;
}

/**
 * 检查并重置过期的每日计数
 */
function checkAndResetDailyCount(keyData) {
    const today = getTodayDateString();
    if (keyData.lastResetDate !== today) {
        keyData.todayUsage = 0;
        keyData.todayPromptTokens = 0;
        keyData.todayCompletionTokens = 0;
        keyData.todayReasoningTokens = 0;
        keyData.todayTotalTokens = 0;
        keyData.todayCachedTokens = 0;
        keyData.lastResetDate = today;
    }
    return keyData;
}

/**
 * 创建新的 API Key
 * @param {string} name - Key 名称
 * @param {number} [dailyLimit] - 每日限额，不传则使用配置的默认值
 */
export async function createKey(name = '', dailyLimit = null) {
    ensureLoaded();
    const config = getConfig();
    const actualDailyLimit = dailyLimit ?? config.defaultDailyLimit ?? DEFAULT_CONFIG.defaultDailyLimit;
    
    const apiKey = generateApiKey();
    const now = new Date().toISOString();
    const today = getTodayDateString();

    const keyData = {
        id: apiKey,
        name: name || `Key-${Object.keys(keyStore.keys).length + 1}`,
        createdAt: now,
        dailyLimit: actualDailyLimit,
        todayUsage: 0,
        totalUsage: 0,
        todayPromptTokens: 0,
        todayCompletionTokens: 0,
        todayReasoningTokens: 0,
        todayTotalTokens: 0,
        todayCachedTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalReasoningTokens: 0,
        totalTokens: 0,
        totalCachedTokens: 0,
        totalModels: {},
        lastResetDate: today,
        lastUsedAt: null,
        enabled: true,
        usageHistory: {}
    };

    keyStore.keys[apiKey] = keyData;
    markDirty();

    await persistIfDirty(); // 创建操作立即持久化

    logger.info(`[API Potluck] Created key: ${apiKey.substring(0, 12)}...`);
    return keyData;
}

/**
 * 获取所有 Key 列表
 */
export async function listKeys(options = {}) {
    ensureLoaded();
    const keys = [];
    const ledgerSnapshot = await readLedgerUsageSnapshot(options);
    for (const [keyId, keyData] of Object.entries(keyStore.keys)) {
        const keyHash = hashSecret(keyId);
        const ledgerKeySnapshot = ledgerSnapshot?.byKeyHash.get(keyHash) || null;
        const updated = enrichKeyUsage(checkAndResetDailyCount({ ...keyData }), {
            ...options,
            summaryOnly: Boolean(options.summaryOnly),
            ledgerUsageHistory: ledgerKeySnapshot?.usageHistory || null,
            ledgerModels: ledgerKeySnapshot?.models || null
        });
        const rates = rateManager.getStats(`key:${keyId}`);
        keys.push({
            ...updated,
            qps: rates.qps,
            tps: rates.tps,
            rpm: rates.rpm,
            maxQps: Math.max(updated.maxQps || 0, rates.maxQps),
            maxTps: Math.max(updated.maxTps || 0, rates.maxTps),
            maxRpm: Math.max(updated.maxRpm || 0, rates.maxRpm),
            maskedKey: `${keyId.substring(0, 12)}...${keyId.substring(keyId.length - 4)}`
        });
    }
    return keys;
}

/**
 * 获取单个 Key 详情
 */
export async function getKey(keyId, options = {}) {
    ensureLoaded();
    const keyData = keyStore.keys[keyId];
    if (!keyData) return null;
    const ledgerSnapshot = await readLedgerUsageSnapshot(options);
    const ledgerKeySnapshot = ledgerSnapshot?.byKeyHash.get(hashSecret(keyId)) || null;
    const updated = enrichKeyUsage(checkAndResetDailyCount({ ...keyData }), {
        ...options,
        ledgerUsageHistory: ledgerKeySnapshot?.usageHistory || null,
        ledgerModels: ledgerKeySnapshot?.models || null
    });
    const rates = rateManager.getStats(`key:${keyId}`);
    return {
        ...updated,
        qps: rates.qps,
        tps: rates.tps,
        rpm: rates.rpm,
        maxQps: Math.max(updated.maxQps || 0, rates.maxQps),
        maxTps: Math.max(updated.maxTps || 0, rates.maxTps),
        maxRpm: Math.max(updated.maxRpm || 0, rates.maxRpm)
    };
}

/**
 * 删除 Key
 */
export async function deleteKey(keyId) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return false;
    delete keyStore.keys[keyId];
    
    // 清理速率追踪器，防止内存泄漏
    rateManager.remove(`key:${keyId}`);

    markDirty();
    await persistIfDirty(); // 删除操作立即持久化
    logger.info(`[API Potluck] Deleted key: ${keyId.substring(0, 12)}...`);
    return true;
}

/**
 * 更新 Key 的每日限额
 */
export async function updateKeyLimit(keyId, newLimit) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].dailyLimit = newLimit;
    markDirty();
    return keyStore.keys[keyId];
}

/**
 * 重置 Key 的当天调用次数
 */
export async function resetKeyUsage(keyId) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].todayUsage = 0;
    keyStore.keys[keyId].todayPromptTokens = 0;
    keyStore.keys[keyId].todayCompletionTokens = 0;
    keyStore.keys[keyId].todayReasoningTokens = 0;
    keyStore.keys[keyId].todayTotalTokens = 0;
    keyStore.keys[keyId].todayCachedTokens = 0;
    keyStore.keys[keyId].lastResetDate = getTodayDateString();
    if (!keyStore.keys[keyId].usageHistory) keyStore.keys[keyId].usageHistory = {};
    keyStore.keys[keyId].usageHistory[getTodayDateString()] = normalizeUsageHistoryDay();
    markDirty();
    return keyStore.keys[keyId];
}

/**
 * 重置单个 Key 的 Token 统计（保留调用次数）
 */
export async function resetKeyTokenStats(keyId) {
    ensureLoaded();
    const keyData = keyStore.keys[keyId];
    if (!keyData) return null;

    keyData.todayPromptTokens = 0;
    keyData.todayCompletionTokens = 0;
    keyData.todayReasoningTokens = 0;
    keyData.todayTotalTokens = 0;
    keyData.todayCachedTokens = 0;
    keyData.totalPromptTokens = 0;
    keyData.totalCompletionTokens = 0;
    keyData.totalReasoningTokens = 0;
    keyData.totalTokens = 0;
    keyData.totalCachedTokens = 0;
    keyData.totalModels = {};
    resetUsageHistoryTokens(keyData.usageHistory);

    // 重置该 Key 的速率追踪器
    rateManager.remove(`key:${keyId}`);

    markDirty();
    await persistIfDirty();
    logger.info(`[API Potluck] Reset token stats for key: ${keyId.substring(0, 12)}...`);
    return keyData;
}

/**
 * 重置所有 Key 的 Token 统计（保留调用次数）
 */
export async function resetAllTokenStats() {
    ensureLoaded();
    let updated = 0;

    for (const keyData of Object.values(keyStore.keys)) {
        keyData.todayPromptTokens = 0;
        keyData.todayCompletionTokens = 0;
        keyData.todayReasoningTokens = 0;
        keyData.todayTotalTokens = 0;
        keyData.todayCachedTokens = 0;
        keyData.totalPromptTokens = 0;
        keyData.totalCompletionTokens = 0;
        keyData.totalReasoningTokens = 0;
        keyData.totalTokens = 0;
        keyData.totalCachedTokens = 0;
        keyData.totalModels = {};
        resetUsageHistoryTokens(keyData.usageHistory);
        updated++;
    }

    // 重置所有 Key 的速率追踪器
    rateManager.clear();

    if (updated > 0) {

        markDirty();
        await persistIfDirty();
    }

    logger.info(`[API Potluck] Reset token stats for all keys: ${updated}`);
    return { total: Object.keys(keyStore.keys).length, updated };
}

/**
 * 切换 Key 的启用/禁用状态
 */
export async function toggleKey(keyId) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].enabled = !keyStore.keys[keyId].enabled;
    markDirty();
    return keyStore.keys[keyId];
}

/**
 * 更新 Key 名称
 */
export async function updateKeyName(keyId, newName) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].name = newName;
    markDirty();
    return keyStore.keys[keyId];
}

// 用于防止同一 Key 下同一请求重复入账，改用 Map 以支持批量清理。
const recordedRequests = new Map();
let lastCleanupTime = Date.now();

/**
 * 清理过期的请求记录
 */
function cleanupRecordedRequests() {
    const now = Date.now();
    if (now - lastCleanupTime < 60000) return; // 每分钟清理一次
    
    const cutoff = now - 5 * 60 * 1000; // 保留短窗口，覆盖 stream/fallback 重复 finalize
    for (const [id, entry] of recordedRequests.entries()) {
        const timestamp = typeof entry === 'number' ? entry : entry?.timestamp;
        if (timestamp < cutoff) recordedRequests.delete(id);
    }
    lastCleanupTime = now;
}

function normalizeRecordedUsage(usage = {}) {
    return {
        requestCount: usage.requestCount !== undefined ? toNumber(usage.requestCount) : 1,
        promptTokens: toNumber(usage.promptTokens),
        completionTokens: toNumber(usage.completionTokens),
        reasoningTokens: toNumber(usage.reasoningTokens),
        totalTokens: toNumber(usage.totalTokens),
        cachedTokens: toNumber(usage.cachedTokens)
    };
}

function maxRecordedUsage(a = {}, b = {}) {
    const left = normalizeRecordedUsage(a);
    const right = normalizeRecordedUsage(b);
    return {
        requestCount: Math.max(left.requestCount, right.requestCount),
        promptTokens: Math.max(left.promptTokens, right.promptTokens),
        completionTokens: Math.max(left.completionTokens, right.completionTokens),
        reasoningTokens: Math.max(left.reasoningTokens, right.reasoningTokens),
        totalTokens: Math.max(left.totalTokens, right.totalTokens),
        cachedTokens: Math.max(left.cachedTokens, right.cachedTokens)
    };
}

function subtractRecordedUsage(current = {}, previous = {}, { includeRequestCount = false } = {}) {
    const next = normalizeRecordedUsage(current);
    const old = normalizeRecordedUsage(previous);
    return {
        requestCount: includeRequestCount ? Math.max(0, next.requestCount - old.requestCount) : 0,
        promptTokens: Math.max(0, next.promptTokens - old.promptTokens),
        completionTokens: Math.max(0, next.completionTokens - old.completionTokens),
        reasoningTokens: Math.max(0, next.reasoningTokens - old.reasoningTokens),
        totalTokens: Math.max(0, next.totalTokens - old.totalTokens),
        cachedTokens: Math.max(0, next.cachedTokens - old.cachedTokens)
    };
}

function hasBillableUsage(usage = {}) {
    return toNumber(usage.requestCount) > 0 ||
        toNumber(usage.promptTokens) > 0 ||
        toNumber(usage.completionTokens) > 0 ||
        toNumber(usage.reasoningTokens) > 0 ||
        toNumber(usage.totalTokens) > 0 ||
        toNumber(usage.cachedTokens) > 0;
}

/**
 * 增加 API Key 的使用量
 * @param {string} apiKey - API Key ID
 * @param {string} pName - 提供商名称
 * @param {string} mName - 模型名称
 * @param {Object} usage - 用量数据
 * @param {string} [requestId] - 请求 ID，用于防止重复统计速率
 */
export async function incrementUsage(apiKey, pName = 'unknown', mName = 'unknown', usage = {}, requestId = null, context = {}) {
    ensureLoaded();
    const keyData = keyStore.keys[apiKey];
    if (!keyData) return;

    const recordedAt = new Date(context.timestamp || usage.timestamp || new Date()).toISOString();
    let usageToApply = usage;
    let ledgerUsageSnapshot = normalizeRecordedUsage(usage);
    let shouldRecordRate = true;
    if (requestId) {
        cleanupRecordedRequests();
        const recordKey = `${apiKey}:${requestId}`;
        const nextUsage = normalizeRecordedUsage(usage);
        const previous = recordedRequests.get(recordKey)?.usage;
        if (previous) {
            const maxUsage = maxRecordedUsage(previous, nextUsage);
            usageToApply = subtractRecordedUsage(maxUsage, previous, { includeRequestCount: false });
            ledgerUsageSnapshot = maxUsage;
            recordedRequests.set(recordKey, { timestamp: Date.now(), usage: maxUsage });
            shouldRecordRate = hasBillableUsage(usageToApply);
        } else {
            ledgerUsageSnapshot = nextUsage;
            recordedRequests.set(recordKey, { timestamp: Date.now(), usage: nextUsage });
        }
    }

    if (!hasBillableUsage(usageToApply)) {
        return {
            ...keyData,
            usedBonus: false
        };
    }

    // 记录速率统计
    if (shouldRecordRate) {
        rateManager.record(`key:${apiKey}`, usageToApply.totalTokens);
    }

    const rates = rateManager.getGlobalStats();
    const updatePeaks = (target) => {
        target.maxQps = Math.max(target.maxQps || 0, rates.qps);
        target.maxRpm = Math.max(target.maxRpm || 0, rates.rpm);
        target.maxTps = Math.max(target.maxTps || 0, rates.tps);
    };

    // 更新每日和历史统计
    const usageRecord = {
        ...usageToApply,
        lastUsedAt: usage.lastUsedAt || recordedAt
    };
    const ledgerUsageRecord = {
        ...ledgerUsageSnapshot,
        lastUsedAt: usage.lastUsedAt || recordedAt
    };
    const today = getTodayDateString();
    if (!keyData.usageHistory) keyData.usageHistory = {};
    if (!keyData.usageHistory[today]) {
        keyData.usageHistory[today] = normalizeUsageHistoryDay();
    }
    
    const dayHistory = keyData.usageHistory[today];
    addUsage(dayHistory.summary, usageRecord);
    updatePeaks(dayHistory.summary);
    
    if (!dayHistory.providers[pName]) dayHistory.providers[pName] = createUsageBucket();
    addUsage(dayHistory.providers[pName], usageRecord);
    updatePeaks(dayHistory.providers[pName]);
    
    if (!dayHistory.models[mName]) dayHistory.models[mName] = createUsageBucket();
    addUsage(dayHistory.models[mName], usageRecord);
    updatePeaks(dayHistory.models[mName]);

    if (!keyData.totalModels) keyData.totalModels = {};
    if (!keyData.totalModels[mName]) keyData.totalModels[mName] = createUsageBucket();
    addUsage(keyData.totalModels[mName], usageRecord);
    updatePeaks(keyData.totalModels[mName]);

    const providerUuid = context.providerUuid || usageRecord.providerUuid || null;
    const providerName = context.providerName || usageRecord.providerName || null;
    const accountIdentity = context.accountIdentity || usageRecord.accountIdentity || null;
    const accountEmail = context.accountEmail || usageRecord.accountEmail || null;
    const accountUsage = ensureAccountUsage(dayHistory.accounts, pName, providerUuid, providerName, accountIdentity, accountEmail);
    if (accountUsage) {
        if (accountEmail && !accountUsage.accountEmail) accountUsage.accountEmail = accountEmail;
        addUsage(accountUsage.summary, usageRecord);
        updatePeaks(accountUsage.summary);
        if (!accountUsage.models[mName]) accountUsage.models[mName] = createUsageBucket();
        addUsage(accountUsage.models[mName], usageRecord);
        updatePeaks(accountUsage.models[mName]);
    }

    const hour = getBeijingHourString(recordedAt);
    const hourUsage = ensureHourUsage(dayHistory, hour);
    addUsage(hourUsage.summary, usageRecord);
    updatePeaks(hourUsage.summary);
    if (!hourUsage.providers[pName]) hourUsage.providers[pName] = createUsageBucket();
    addUsage(hourUsage.providers[pName], usageRecord);
    updatePeaks(hourUsage.providers[pName]);
    if (!hourUsage.models[mName]) hourUsage.models[mName] = createUsageBucket();
    addUsage(hourUsage.models[mName], usageRecord);
    updatePeaks(hourUsage.models[mName]);
    const hourAccountUsage = ensureAccountUsage(hourUsage.accounts, pName, providerUuid, providerName, accountIdentity, accountEmail);
    if (hourAccountUsage) {
        if (accountEmail && !hourAccountUsage.accountEmail) hourAccountUsage.accountEmail = accountEmail;
        addUsage(hourAccountUsage.summary, usageRecord);
        updatePeaks(hourAccountUsage.summary);
        if (!hourAccountUsage.models[mName]) hourAccountUsage.models[mName] = createUsageBucket();
        addUsage(hourAccountUsage.models[mName], usageRecord);
        updatePeaks(hourAccountUsage.models[mName]);
    }

    // 更新今日和累计总量 (统一处理默认调用次数)
    const rCount = usageRecord.requestCount !== undefined ? toNumber(usageRecord.requestCount) : 1;
    keyData.todayUsage += rCount;
    keyData.totalUsage += rCount;
    keyData.todayPromptTokens += toNumber(usageRecord.promptTokens);
    keyData.todayCompletionTokens += toNumber(usageRecord.completionTokens);
    keyData.todayReasoningTokens += toNumber(usageRecord.reasoningTokens);
    keyData.todayTotalTokens += toNumber(usageRecord.totalTokens);
    keyData.todayCachedTokens += toNumber(usageRecord.cachedTokens);
    keyData.totalPromptTokens += toNumber(usageRecord.promptTokens);
    keyData.totalCompletionTokens += toNumber(usageRecord.completionTokens);
    keyData.totalReasoningTokens += toNumber(usageRecord.reasoningTokens);
    keyData.totalTokens += toNumber(usageRecord.totalTokens);
    keyData.totalCachedTokens += toNumber(usageRecord.cachedTokens);
    keyData.lastUsedAt = recordedAt;

    try {
        await getUsageLedgerStore().recordFact({
            timestamp: recordedAt,
            requestId,
            potluckKeyHash: hashSecret(apiKey),
            potluckKeyId: keyData.id || apiKey,
            potluckKeyName: keyData.name || null,
            provider: pName,
            providerUuid,
            accountEmail,
            accountDisplay: sanitizeProviderName(providerName),
            requestedModel: context.requestedModel || mName,
            actualModel: context.actualModel || mName,
            requestCount: ledgerUsageRecord.requestCount,
            promptTokens: ledgerUsageRecord.promptTokens,
            cachedTokens: ledgerUsageRecord.cachedTokens,
            completionTokens: ledgerUsageRecord.completionTokens,
            reasoningTokens: ledgerUsageRecord.reasoningTokens,
            totalTokens: ledgerUsageRecord.totalTokens,
            stream: Boolean(context.isStream),
            source: 'api-potluck'
        });
    } catch (error) {
        logger.warn('[API Potluck] Failed to record usage ledger fact:', error.message);
    }

    // 同时也给 keyData 注入实时峰值（如果需要持久化）
    if (!keyData.maxQps) keyData.maxQps = 0;
    if (!keyData.maxRpm) keyData.maxRpm = 0;
    if (!keyData.maxTps) keyData.maxTps = 0;
    updatePeaks(keyData);

    // 清理该 Key 的过期历史。
    trimUsageHistory(keyData.usageHistory, USAGE_HISTORY_RETENTION_DAYS);

    markDirty();
    
    return {
        ...keyData,
        usedBonus: false
    };
}

/**
 * 获取统计信息
 */
export async function getStats(options = {}) {
    ensureLoaded();
    const { conversionModel } = getCostOptions(options);
    const ledgerSnapshot = await readLedgerUsageSnapshot(options);
    const keys = Object.values(keyStore.keys);
    let enabledKeys = 0, todayTotalUsage = 0, totalUsage = 0;
    let todayPromptTokens = 0, todayCompletionTokens = 0, todayReasoningTokens = 0, todayTotalTokens = 0, todayCachedTokens = 0;
    let totalPromptTokens = 0, totalCompletionTokens = 0, totalReasoningTokens = 0, totalTokens = 0, totalCachedTokens = 0;
    let aggregatedHistory = {};
    let aggregateModels = {};

    for (const key of keys) {
        checkAndResetDailyCount(key);
        if (key.enabled) enabledKeys++;
        todayTotalUsage += key.todayUsage;
        totalUsage += key.totalUsage;
        todayPromptTokens += key.todayPromptTokens || 0;
        todayCompletionTokens += key.todayCompletionTokens || 0;
        todayReasoningTokens += key.todayReasoningTokens || 0;
        todayTotalTokens += key.todayTotalTokens || 0;
        todayCachedTokens += key.todayCachedTokens || 0;
        totalPromptTokens += key.totalPromptTokens || 0;
        totalCompletionTokens += key.totalCompletionTokens || 0;
        totalReasoningTokens += key.totalReasoningTokens || 0;
        totalTokens += key.totalTokens || 0;
        totalCachedTokens += key.totalCachedTokens || 0;
        Object.entries(key.totalModels || collectModelsFromUsageHistory(key.usageHistory || {})).forEach(([model, usage]) => {
            aggregateModels[model] = normalizeUsageBucket(aggregateModels[model]);
            addUsage(aggregateModels[model], usage);
        });

        // 汇总每个 Key 的历史数据
        if (key.usageHistory) {
            Object.entries(key.usageHistory).forEach(([date, history]) => {
                if (!aggregatedHistory[date]) {
                    aggregatedHistory[date] = normalizeUsageHistoryDay();
                }
                addUsage(aggregatedHistory[date].summary, history.summary);
                
                // 汇总提供商
                if (history.providers) {
                    Object.entries(history.providers).forEach(([p, usage]) => {
                        aggregatedHistory[date].providers[p] = normalizeUsageBucket(aggregatedHistory[date].providers[p]);
                        addUsage(aggregatedHistory[date].providers[p], usage);
                    });
                }
                
                // 汇总模型
                if (history.models) {
                    Object.entries(history.models).forEach(([m, usage]) => {
                        aggregatedHistory[date].models[m] = normalizeUsageBucket(aggregatedHistory[date].models[m]);
                        addUsage(aggregatedHistory[date].models[m], usage);
                    });
                }

                // 汇总账号维度，供管理页展示 Codex OAuth 账号 Token 占比。
                if (history.accounts) {
                    Object.values(history.accounts).forEach((account) => {
                        addAccountUsage(aggregatedHistory[date].accounts, account);
                    });
                }
            });
        }
    }

    const globalRates = rateManager.getGlobalStats();
    if (ledgerSnapshot) {
        aggregatedHistory = ledgerSnapshot.usageHistory;
        const todaySummary = aggregatedHistory[getTodayDateString()]?.summary || createUsageBucket();
        todayTotalUsage = toNumber(todaySummary.requestCount);
        todayPromptTokens = toNumber(todaySummary.promptTokens);
        todayCompletionTokens = toNumber(todaySummary.completionTokens);
        todayReasoningTokens = toNumber(todaySummary.reasoningTokens);
        todayTotalTokens = toNumber(todaySummary.totalTokens);
        todayCachedTokens = toNumber(todaySummary.cachedTokens);
    } else {
        trimUsageHistory(aggregatedHistory, USAGE_HISTORY_RETENTION_DAYS);
        addUsageHistoryRatios(aggregatedHistory);
        addCostToUsageHistory(aggregatedHistory, conversionModel);
    }
    const keyStoreAggregateUsage = {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        reasoningTokens: totalReasoningTokens,
        totalTokens,
        cachedTokens: totalCachedTokens
    };
    const useLedgerTotals = ledgerSnapshot && !hasUsageTotals({
        ...keyStoreAggregateUsage,
        requestCount: totalUsage
    });
    const aggregateUsage = useLedgerTotals ? ledgerSnapshot.totals : keyStoreAggregateUsage;
    const costModels = Object.keys(aggregateModels || {}).length > 0
        ? aggregateModels
        : (ledgerSnapshot?.models || aggregateModels);
    if (useLedgerTotals) {
        totalUsage = toNumber(ledgerSnapshot.totals.requestCount);
        totalPromptTokens = toNumber(ledgerSnapshot.totals.promptTokens);
        totalCompletionTokens = toNumber(ledgerSnapshot.totals.completionTokens);
        totalReasoningTokens = toNumber(ledgerSnapshot.totals.reasoningTokens);
        totalTokens = toNumber(ledgerSnapshot.totals.totalTokens);
        totalCachedTokens = toNumber(ledgerSnapshot.totals.cachedTokens);
    }
    return {
        usageFactSource: ledgerSnapshot ? 'usage-ledger' : 'api-potluck-keys',
        totalKeys: keys.length,
        enabledKeys,
        disabledKeys: keys.length - enabledKeys,
        todayTotalUsage,
        totalUsage,
        todayPromptTokens,
        todayCompletionTokens,
        todayReasoningTokens,
        todayTotalTokens,
        todayCachedTokens,
        todayCacheHitRatio: todayPromptTokens > 0 ? todayCachedTokens / todayPromptTokens : 0,
        totalPromptTokens,
        totalCompletionTokens,
        totalReasoningTokens,
        totalTokens,
        totalCachedTokens,
        totalCacheHitRatio: totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0,
        qps: globalRates.qps,
        tps: globalRates.tps,
        rpm: globalRates.rpm,
        maxQps: globalRates.maxQps,
        maxTps: globalRates.maxTps,
        maxRpm: globalRates.maxRpm,
        cost: buildCost(aggregateUsage, costModels, conversionModel),
        pricing: {
            conversionModels: getConversionModels()
        },
        usageHistory: aggregatedHistory
    };
}

/**
 * 获取按真实账号聚合的今日 / 本周 / 本月使用量。
 * 用量查询页只需要轻量摘要，避免拉取全部 Potluck Key 历史。
 */
export async function getAccountUsageSummary(now = new Date()) {
    const { conversionModel } = getCostOptions();
    const ledgerSnapshot = await readLedgerUsageSnapshot({ conversionModel });
    const modelUsageHistory = ledgerSnapshot ? null : readModelUsageDailyHistory(conversionModel);
    const stats = ledgerSnapshot || modelUsageHistory ? null : await getStats({ conversionModel });
    const usageHistory = ledgerSnapshot?.usageHistory || modelUsageHistory || stats?.usageHistory || {};
    const source = ledgerSnapshot ? 'usage-ledger' : (modelUsageHistory ? 'model-usage-stats/daily' : 'potluck/model-usage-stats');
    const starts = getBeijingPeriodStarts(now);
    const accounts = new Map();
    const aliasIndex = new Map();

    for (const [dateKey, day] of Object.entries(usageHistory)) {
        const inToday = dateKey === starts.today;
        const inWeek = dateKey >= starts.week;
        const inMonth = dateKey >= starts.month;
        if (!inToday && !inWeek && !inMonth) continue;

        for (const [accountKey, account] of Object.entries(day.accounts || {})) {
            const aliases = getAccountSummaryAliases(accountKey, account);
            let targetKey = aliases.map(alias => aliasIndex.get(alias)).find(Boolean);
            const preferredKey = getSummaryCanonicalAccountKey(accountKey, account);

            if (!targetKey) {
                targetKey = preferredKey;
            } else {
                const current = accounts.get(targetKey);
                const currentPreferredKey = getSummaryCanonicalAccountKey(targetKey, current);
                const shouldPromoteToIncomingIdentity = account.accountIdentity && (
                    !current?.accountIdentity ||
                    (account.accountEmail && current.accountIdentity !== account.accountEmail)
                );
                const nextKey = shouldPromoteToIncomingIdentity ? preferredKey : currentPreferredKey;
                if (nextKey && nextKey !== targetKey) {
                    accounts.delete(targetKey);
                    current.accountKey = nextKey;
                    accounts.set(nextKey, current);
                    reassignAccountSummaryAliases(aliasIndex, targetKey, nextKey);
                    targetKey = nextKey;
                }
            }

            const current = accounts.get(targetKey) || createAccountSummaryEntry(targetKey, account);
            current.accountKey = targetKey;
            mergeAccountSummaryMeta(current, account, accountKey);
            if (!accounts.has(targetKey)) {
                accounts.set(targetKey, current);
            }

            if (inToday) addAccountSummaryRange(current, 'today', account);
            if (inWeek) addAccountSummaryRange(current, 'week', account);
            if (inMonth) addAccountSummaryRange(current, 'month', account);

            for (const alias of getAccountSummaryAliases(current.accountKey, current)) {
                aliasIndex.set(alias, targetKey);
            }
            for (const alias of aliases) {
                aliasIndex.set(alias, targetKey);
            }
        }
    }

    const modelUsageLastUsedIndex = readModelUsageAccountLastUsedIndex();
    const accountList = [...accounts.values()]
        .map(account => {
            const today = cloneUsageBucket(account.today);
            const week = cloneUsageBucket(account.week);
            const month = cloneUsageBucket(account.month);
            addCacheHitRatio(today);
            addCacheHitRatio(week);
            addCacheHitRatio(month);
            return {
                ...account,
                lastUsedAt: latestTimestamp(
                    latestTimestamp(today.lastUsedAt, week.lastUsedAt),
                    latestTimestamp(month.lastUsedAt, getIndexedAccountLastUsedAt(account, modelUsageLastUsedIndex))
                ),
                today,
                week,
                month
            };
        })
        .sort((a, b) => (
            b.month.totalTokens - a.month.totalTokens ||
            b.week.totalTokens - a.week.totalTokens ||
            b.today.totalTokens - a.today.totalTokens ||
            (a.providerName || a.providerUuid || '').localeCompare(b.providerName || b.providerUuid || '')
        ));

    return {
        source,
        timezone: 'Asia/Shanghai',
        periods: starts,
        updatedAt: new Date().toISOString(),
        accounts: accountList
    };
}


/**
 * 批量更新所有 Key 的每日限额
 * @param {number} newLimit - 新s的每日限额
 * @returns {Promise<{total: number, updated: number}>}
 */
export async function applyDailyLimitToAllKeys(newLimit) {
    ensureLoaded();
    const keys = Object.values(keyStore.keys);
    let updated = 0;
    
    for (const keyData of keys) {
        if (keyData.dailyLimit !== newLimit) {
            keyData.dailyLimit = newLimit;
            updated++;
        }
    }
    
    if (updated > 0) {
        markDirty();
        await persistIfDirty();
    }
    
    logger.info(`[API Potluck] Applied daily limit ${newLimit} to ${updated}/${keys.length} keys`);
    return { total: keys.length, updated };
}

/**
 * 获取所有 Key ID 列表
 * @returns {string[]}
 */
export function getAllKeyIds() {
    ensureLoaded();
    return Object.keys(keyStore.keys);
}

/**
 * 验证 API Key 是否有效
 * @param {string} apiKey - 待验证的 Key
 * @returns {Promise<{valid: boolean, reason?: string, keyData?: Object}>}
 */
export async function validateKey(apiKey) {
    ensureLoaded();
    if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) {
        return { valid: false, reason: 'invalid_format' };
    }
    const keyData = keyStore.keys[apiKey];
    if (!keyData) {
        return { valid: false, reason: 'not_found' };
    }
    if (!keyData.enabled) {
        return { valid: false, reason: 'disabled' };
    }
    const updated = checkAndResetDailyCount(keyData);
    if (updated.dailyLimit > 0 && updated.todayUsage >= updated.dailyLimit) {
        return { valid: false, reason: 'quota_exceeded', keyData: updated };
    }
    return { valid: true, keyData: updated };
}

/**
 * 重新生成 API Key（保留原有数据，更换 Key ID）
 * @param {string} oldKeyId - 原 Key ID
 * @returns {Promise<{oldKey: string, newKey: string, keyData: Object}|null>}
 */
export async function regenerateKey(oldKeyId) {
    ensureLoaded();
    const oldKeyData = keyStore.keys[oldKeyId];
    if (!oldKeyData) return null;
    
    // 生成新的唯一 Key
    const newKeyId = generateApiKey();
    
    // 复制数据到新 Key
    const newKeyData = {
        ...oldKeyData,
        id: newKeyId,
        regeneratedAt: new Date().toISOString(),
        regeneratedFrom: oldKeyId.substring(0, 12) + '...'
    };
    
    // 删除旧 Key，添加新 Key
    delete keyStore.keys[oldKeyId];
    keyStore.keys[newKeyId] = newKeyData;
    
    // 清理旧 Key 的速率追踪器
    rateManager.remove(`key:${oldKeyId}`);

    markDirty();
    await persistIfDirty();
    
    return {
        oldKey: oldKeyId,
        newKey: newKeyId,
        keyData: newKeyData
    };
}

// 导出常量
export { KEY_PREFIX };
