/**
 * API 大锅饭 - 管理 API 路由
 * 提供 Key 管理的 RESTful API
 */

import {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    updateKeyRouting,
    updateKeyEdgeAdmission,
    regenerateKey,
    getStats,
    getAccountUsageSummary,
    validateKey,
    KEY_PREFIX,
    applyDailyLimitToAllKeys,
    getAllKeyIds,
    getLedgerKeyIdentities,
    resetAllTokenStats,
    resolveKeyIdByHash
} from './key-manager.js';
import { getRequestBody } from '../../utils/common.js';
import { extractCodexCredentialIdentity } from '../../utils/codex-utils.js';
import { getBeijingDateKey, listLedgerDates, readLedgerRangeStats, readSqliteRowsForDates, resolveRangeDates } from './ledger-range-stats.js';
import { readFreshUsageCacheSync, getCachedCodexUsageInstance } from '../../utils/codex-plan.js';
import { normalizeCodexRateLimitWindows } from '../../utils/codex-rate-limit.js';
import { getProviderUiAvailability } from '../../utils/provider-ui-availability.js';
import { hashSecret, sanitizeProviderName } from '../request-audit/audit-event.js';
import logger from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

const STATS_CACHE_TTL_MS = 30 * 1000;
const statsCache = new Map();
const overviewCache = new Map();

/**
 * 发送 JSON 响应
 */
function sendJson(res, statusCode, data) {
    if (res.headersSent || res.writableEnded || res.destroyed) return false;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
}

function compactUserCost(cost = {}) {
    return {
        usd: Number(cost.usd || 0),
        actualUsd: Number(cost.actualUsd || 0),
        estimatedUsd: Number(cost.estimatedUsd || 0),
        missingPriceTokens: Number(cost.missingPriceTokens || 0),
        estimatedPriceTokens: Number(cost.estimatedPriceTokens || 0),
        pricingVersion: cost.pricingVersion || null
    };
}

function getRequestCostOptions(req) {
    try {
        const url = new URL(req.url || '', 'http://localhost');
        return {
            conversionModel: url.searchParams.get('conversionModel') || undefined
        };
    } catch {
        return {};
    }
}

function getStatsCacheKey(costOptions = {}) {
    return [
        costOptions.conversionModel || '',
        costOptions.compactHistory ? 'compact-history' : 'full-history',
        costOptions.compactAccounts ? 'compact-accounts' : 'full-accounts',
        costOptions.includeKeySummaries ? 'with-key-summaries' : 'without-key-summaries'
    ].join(':');
}

function clearStatsCache() {
    statsCache.clear();
    overviewCache.clear();
}

const LIST_KEY_FIELDS = [
    'name', 'enabled', 'dailyLimit', 'todayUsage', 'todayPromptTokens', 'todayCompletionTokens',
    'todayReasoningTokens', 'todayTotalTokens', 'todayCachedTokens', 'totalUsage', 'totalPromptTokens',
    'totalCompletionTokens', 'totalReasoningTokens', 'totalTokens', 'totalCachedTokens', 'lastResetDate',
    'lastUsedAt', 'qps', 'tps', 'rpm', 'maxQps', 'maxTps', 'maxRpm', 'routingMode',
    'manualLock', 'edgeAdmissionMode', 'edgeAdmissionConcurrencyLimit', 'edgeAdmissionQueueLimit',
    'edgeAdmissionQueueTimeoutMs', 'edgeAuthRpmLimit', 'maskedKey',
    'weeklyUsage', 'weeklyPromptTokens', 'weeklyCompletionTokens', 'weeklyReasoningTokens',
    'weeklyTotalTokens', 'weeklyCachedTokens', 'todayCacheHitRatio', 'weeklyCacheHitRatio',
    'totalCacheHitRatio', 'cost', 'displayUsageSource', 'displayUsageDate',
    'displayUsageReadAt', 'displayUsageLastEventAt', 'displayUsageMemoryDelta'
];

function getRequestDetailOptions(req) {
    try {
        const detail = new URL(req.url || '', 'http://localhost').searchParams.get('detail');
        return ['summary', 'history', 'full'].includes(detail) ? detail : 'full';
    } catch {
        return 'full';
    }
}

function resolveManagementKeyId(keyId) {
    return (typeof resolveKeyIdByHash === 'function' ? resolveKeyIdByHash(keyId) : null) || keyId;
}

function shapeStatsByDetail(stats, detail) {
    // Supported public levels: detail=summary, detail=history, detail=full.
    if (detail === 'full') return stats;
    const shaped = { ...stats };
    if (detail === 'summary') {
        shaped.usageHistory = Object.fromEntries(
            Object.entries(stats.usageHistory || {}).map(([date, day]) => [date, { summary: day?.summary || {} }])
        );
    } else if (detail === 'history') {
        shaped.usageHistory = Object.fromEntries(
            Object.entries(stats.usageHistory || {}).map(([date, day]) => [date, {
                summary: day?.summary || {},
                providers: day?.providers || {},
                models: day?.models || {},
                providerModels: day?.providerModels || {}
            }])
        );
    }
    return shaped;
}

function getCachedStats(costOptions = {}) {
    const cacheKey = getStatsCacheKey(costOptions);
    const now = Date.now();
    const entry = statsCache.get(cacheKey);
    if (entry?.value && now - entry.createdAt < STATS_CACHE_TTL_MS) return entry.value;
    if (entry?.promise) return entry.promise;

    const promise = getStats(costOptions)
        .then(stats => {
            statsCache.set(cacheKey, { value: stats, createdAt: Date.now() });
            return stats;
        })
        .catch(error => {
            statsCache.delete(cacheKey);
            throw error;
        });
    statsCache.set(cacheKey, { promise, createdAt: now });
    return promise;
}

function usageDisplaySummary(bucket = {}) {
    return {
        requestCount: Number(bucket.requestCount || 0),
        promptTokens: Number(bucket.promptTokens || 0),
        completionTokens: Number(bucket.completionTokens || 0),
        reasoningTokens: Number(bucket.reasoningTokens || 0),
        totalTokens: Number(bucket.totalTokens || 0),
        cachedTokens: Number(bucket.cachedTokens || 0),
        cacheHitRatio: Number(bucket.cacheHitRatio || 0),
        cost: bucket.cost || null,
        lastUsedAt: bucket.lastUsedAt || null
    };
}

function overlayUsageFields(target, summary, prefix = '') {
    const usage = usageDisplaySummary(summary);
    target[`${prefix}Usage`] = usage.requestCount;
    target[`${prefix}PromptTokens`] = usage.promptTokens;
    target[`${prefix}CompletionTokens`] = usage.completionTokens;
    target[`${prefix}ReasoningTokens`] = usage.reasoningTokens;
    target[`${prefix}TotalTokens`] = usage.totalTokens;
    target[`${prefix}CachedTokens`] = usage.cachedTokens;
    return usage;
}

function overlayDisplayUsageOnStats(stats, snapshots = {}) {
    const today = snapshots.today?.summary || {};
    const week = snapshots['7d']?.summary || {};
    const total = snapshots.total?.summary || {};
    const result = { ...stats };
    result.todayTotalUsage = Number(today.requestCount || 0);
    result.todayPromptTokens = Number(today.promptTokens || 0);
    result.todayCompletionTokens = Number(today.completionTokens || 0);
    result.todayReasoningTokens = Number(today.reasoningTokens || 0);
    result.todayTotalTokens = Number(today.totalTokens || 0);
    result.todayCachedTokens = Number(today.cachedTokens || 0);
    result.totalUsage = Number(total.requestCount || 0);
    result.totalPromptTokens = Number(total.promptTokens || 0);
    result.totalCompletionTokens = Number(total.completionTokens || 0);
    result.totalReasoningTokens = Number(total.reasoningTokens || 0);
    result.totalTokens = Number(total.totalTokens || 0);
    result.totalCachedTokens = Number(total.cachedTokens || 0);
    result.weeklyUsage = Number(week.requestCount || 0);
    result.weeklyPromptTokens = Number(week.promptTokens || 0);
    result.weeklyCompletionTokens = Number(week.completionTokens || 0);
    result.weeklyReasoningTokens = Number(week.reasoningTokens || 0);
    result.weeklyTotalTokens = Number(week.totalTokens || 0);
    result.weeklyCachedTokens = Number(week.cachedTokens || 0);
    result.todayCacheHitRatio = Number(today.cacheHitRatio || 0);
    result.totalCacheHitRatio = Number(total.cacheHitRatio || 0);
    const todaySource = snapshots.today?.keySummarySource === 'sqlite-preaggregated'
        ? 'sqlite-current-day'
        : 'ledger';
    const historySource = snapshots.total?.keySummarySource === 'sqlite-preaggregated'
        ? 'ledger+sqlite-current-day'
        : 'ledger';
    result.displayUsageSource = { today: todaySource, history: historySource };
    result.displayUsageDate = snapshots.today?.from || getBeijingDateKey();
    result.displayUsageReadAt = new Date().toISOString();

    result.keySummaries = (stats.keySummaries || []).map(key => {
        const ref = hashSecret(key.id);
        const todayKey = snapshots.today?.keySummaries?.[ref]?.summary || {};
        const weekKey = snapshots['7d']?.keySummaries?.[ref]?.summary || {};
        const totalKey = snapshots.total?.keySummaries?.[ref]?.summary || {};
        const next = { ...key };
        const displayToday = overlayUsageFields(next, todayKey, 'today');
        const displayTotal = usageDisplaySummary(totalKey);
        next.totalUsage = displayTotal.requestCount;
        next.totalPromptTokens = displayTotal.promptTokens;
        next.totalCompletionTokens = displayTotal.completionTokens;
        next.totalReasoningTokens = displayTotal.reasoningTokens;
        next.totalTokens = displayTotal.totalTokens;
        next.totalCachedTokens = displayTotal.cachedTokens;
        next.weeklyUsage = Number(weekKey.requestCount || 0);
        next.weeklyPromptTokens = Number(weekKey.promptTokens || 0);
        next.weeklyCompletionTokens = Number(weekKey.completionTokens || 0);
        next.weeklyReasoningTokens = Number(weekKey.reasoningTokens || 0);
        next.weeklyTotalTokens = Number(weekKey.totalTokens || 0);
        next.weeklyCachedTokens = Number(weekKey.cachedTokens || 0);
        next.todayCacheHitRatio = displayToday.cacheHitRatio;
        next.weeklyCacheHitRatio = Number(weekKey.cacheHitRatio || 0);
        next.totalCacheHitRatio = Number(totalKey.cacheHitRatio || 0);
        next.cost = totalKey.cost || next.cost;
        next.weeklyCost = weekKey.cost || next.weeklyCost;
        next.displayUsageSource = result.displayUsageSource;
        next.displayUsageDate = result.displayUsageDate;
        next.displayUsageReadAt = result.displayUsageReadAt;
        next.displayUsageLastEventAt = displayToday.lastUsedAt || totalKey.lastUsedAt || null;
        next.displayUsageMemoryDelta = {
            requestCount: displayToday.requestCount - Number(key.todayUsage || 0),
            totalTokens: displayToday.totalTokens - Number(key.todayTotalTokens || 0)
        };
        return next;
    });
    return result;
}

async function loadDisplayUsageSnapshots(conversionModel) {
    const [today, week, total] = await Promise.all([
        loadLedgerRangeStatsForRange('today', conversionModel, { includeKeySummaries: true }),
        loadLedgerRangeStatsForRange('7d', conversionModel, { includeKeySummaries: true }),
        loadLedgerRangeStatsForRange('total', conversionModel, { includeKeySummaries: true })
    ]);
    return { today, '7d': week, total };
}

function getCachedOverview(costOptions = {}) {
    const cacheKey = getStatsCacheKey({ ...costOptions, compactHistory: true, compactAccounts: true });
    const now = Date.now();
    const entry = overviewCache.get(cacheKey);
    if (entry?.value && now - entry.createdAt < STATS_CACHE_TTL_MS) return entry.value;
    if (entry?.promise) return entry.promise;

    const promise = getCachedStats({
        ...costOptions,
        compactHistory: true,
        compactAccounts: true,
        includeKeySummaries: true
    }).then(async stats => {
        const snapshots = await loadDisplayUsageSnapshots(costOptions.conversionModel);
        stats = overlayDisplayUsageOnStats(stats, snapshots);
        const keys = (stats.keySummaries || []).map(key => ({
            ...key,
            maskedKey: `${String(key.id || '').substring(0, 12)}...${String(key.id || '').slice(-4)}`
        }));
        const { keySummaries, ...summaryStats } = stats;
        const overview = { keys: keys.map(compactKeyForList), stats: summaryStats };
        overviewCache.set(cacheKey, { value: overview, createdAt: Date.now() });
        return overview;
    }).catch(error => {
        overviewCache.delete(cacheKey);
        throw error;
    });
    overviewCache.set(cacheKey, { promise, createdAt: now });
    return promise;
}

function compactUsageHistoryForList(usageHistory = {}, maxDays = 7) {
    const compact = { usageHistory: {} };
    const entries = Object.entries(usageHistory || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-Math.max(0, Number(maxDays) || 0));
    for (const [date, day] of entries) {
        compact.usageHistory[date] = { summary: day?.summary || {} };
        delete compact.usageHistory[date].providers;
        delete compact.usageHistory[date].models;
        delete compact.usageHistory[date].accounts;
        delete compact.usageHistory[date].hours;
    }
    return compact.usageHistory;
}

function compactKeyForList(key) {
    const fixedCredential = key?.fixedCredential?.uuid
        ? {
            providerType: key.fixedCredential.providerType || 'openai-codex-oauth',
            credentialRef: getCredentialRef(
                key.fixedCredential.providerType || 'openai-codex-oauth',
                key.fixedCredential.uuid
            )
        }
        : null;
    const result = {
        keyRef: hashSecret(key.id), id: hashSecret(key.id), fixedCredential,
        credentialRefs: compactRestrictedCredentialRefs(key.restrictedCredentialUuids)
    };
    for (const field of LIST_KEY_FIELDS) result[field] = key[field];
    result.usageHistory = compactUsageHistoryForList(key.usageHistory || {}, 7);
    return result;
}

function compactFixedCredential(fixedCredential) {
    if (!fixedCredential?.uuid) return fixedCredential || null;
    return {
        providerType: fixedCredential.providerType || 'openai-codex-oauth',
        credentialRef: getCredentialRef(
            fixedCredential.providerType || 'openai-codex-oauth',
            fixedCredential.uuid
        )
    };
}

function compactRestrictedCredentialRefs(uuids) {
    return Array.isArray(uuids)
        ? uuids.map(uuid => getCredentialRef('openai-codex-oauth', uuid))
        : [];
}

function sanitizeKeyManagementData(keyData = {}) {
    const keyRef = hashSecret(keyData.id);
    const result = { ...keyData, id: keyRef, keyRef };
    result.fixedCredential = compactFixedCredential(result.fixedCredential);
    result.credentialRefs = compactRestrictedCredentialRefs(result.restrictedCredentialUuids);
    delete result.restrictedCredentialUuids;
    delete result.concurrencyMode;
    delete result.concurrencyLimit;
    delete result.queueLimit;
    delete result.queueTimeoutMs;
    return result;
}

function formatDailyLimitMessage(dailyLimit) {
    return dailyLimit === 0 ? '不限量' : dailyLimit;
}

const PERSISTENCE_PENDING_MESSAGE = '变更已在内存生效，持久化暂未完成，系统将在后台重试；服务重启前请稍后确认。';

function sendManagementMutationResponse(res, {
    result,
    message,
    data = result,
    successStatusCode = 200
}) {
    const persistencePending = Boolean(result?.persistencePending);
    const responseData = data && typeof data === 'object' && !Array.isArray(data)
        ? { ...data }
        : data;
    if (responseData && typeof responseData === 'object') {
        delete responseData.persistencePending;
    }
    clearStatsCache();
    sendJson(res, persistencePending ? 202 : successStatusCode, {
        success: true,
        persistencePending,
        message: persistencePending ? `${message} ${PERSISTENCE_PENDING_MESSAGE}` : message,
        data: responseData
    });
}

function compactKeyManagementMutationData(keyData = {}) {
    const keyRef = hashSecret(keyData.id);
    return {
        id: keyRef,
        keyRef,
        name: keyData.name || '',
        enabled: keyData.enabled !== false,
        dailyLimit: Number(keyData.dailyLimit || 0),
        lastResetDate: keyData.lastResetDate || null,
        routingMode: keyData.routingMode || 'pool',
        fixedCredential: compactFixedCredential(keyData.fixedCredential),
        credentialRefs: compactRestrictedCredentialRefs(keyData.restrictedCredentialUuids),
        manualLock: keyData.manualLock === true,
        edgeAdmissionMode: keyData.edgeAdmissionMode === 'enforce' ? 'enforce' : 'disabled',
        edgeAdmissionConcurrencyLimit: Number(keyData.edgeAdmissionConcurrencyLimit ?? keyData.concurrencyLimit ?? 0),
        edgeAdmissionQueueLimit: Number(keyData.edgeAdmissionQueueLimit ?? keyData.queueLimit ?? 0),
        edgeAdmissionQueueTimeoutMs: Number(keyData.edgeAdmissionQueueTimeoutMs ?? keyData.queueTimeoutMs ?? 300000),
        edgeAuthRpmLimit: Number(keyData.edgeAuthRpmLimit || 0) || null,
        configSyncEpoch: keyData.configSyncEpoch || null,
        configSyncRevision: keyData.configSyncRevision || null,
        routingConfigRevision: keyData.routingConfigRevision || null
    };
}

function isCodexProviderType(providerType) {
    return providerType === 'openai-codex-oauth'
        || String(providerType || '').startsWith('openai-codex-oauth-');
}

function normalizeRemainingRatio(value) {
    if (value === undefined || value === null || value === '') return null;
    let ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    if (ratio > 1 && ratio <= 100) ratio /= 100;
    return Math.max(0, Math.min(1, ratio));
}

function normalizeUsedPercent(value) {
    const percent = Number(value);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function getUsageWindowUsedPercent(window) {
    return normalizeUsedPercent(
        window?.percent
        ?? window?.usedPercent
        ?? window?.used
        ?? window?.used_percent
    );
}

function getCodexQuotaRemainingRatios(usage) {
    if (!usage || typeof usage !== 'object') {
        return { fiveHourRemainingRatio: null, weeklyRemainingRatio: null };
    }

    const itemWindows = (Array.isArray(usage.items) ? usage.items : [])
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            ...item,
            id: item.id || item.sourceWindow || null,
            sourceWindow: item.sourceWindow || item.id || null,
            scope: item.scope || 'general',
            windowKind: item.windowKind || null,
            usedPercent: getUsageWindowUsedPercent(item)
        }));
    const rawWindows = normalizeCodexRateLimitWindows(usage.raw || usage)
        .map(window => ({
            ...window,
            usedPercent: getUsageWindowUsedPercent(window)
        }));
    const windows = [...itemWindows, ...rawWindows]
        .filter(window => window.scope === 'general' && window.usedPercent !== null);

    const shortWindow = windows.find(window => window.windowKind === 'short')
        || windows.find(window => window.id === 'primary_window' || window.sourceWindow === 'primary_window');
    const weeklyWindow = windows.find(window => window.windowKind === 'weekly')
        || windows.find(window => window.id === 'secondary_window' || window.sourceWindow === 'secondary_window');

    return {
        fiveHourRemainingRatio: shortWindow ? 1 - shortWindow.usedPercent / 100 : null,
        weeklyRemainingRatio: weeklyWindow ? 1 - weeklyWindow.usedPercent / 100 : null
    };
}

function normalizeCodexCredential(providerType, provider, usageCache) {
    const config = provider?.config && typeof provider.config === 'object'
        ? provider.config
        : (provider || {});
    const uuid = provider?.uuid || config.uuid || null;
    if (!uuid || !isCodexProviderType(providerType)) return null;

    const cachedInstance = getCachedCodexUsageInstance(providerType, uuid, usageCache);
    const quotaRatios = getCodexQuotaRemainingRatios(cachedInstance?.usage);
    const quotaHealth = config.codexQuotaHealth || cachedInstance?.codexQuotaHealth || null;
    const fiveHourRemainingRatio = normalizeRemainingRatio(
        config.fiveHourRemainingRatio
        ?? config.shortWindowRemainingRatio
        ?? config.quota?.fiveHourRemainingRatio
        ?? config.quota?.shortRemainingRatio
        ?? quotaRatios.fiveHourRemainingRatio
    );
    const weeklyRemainingRatio = normalizeRemainingRatio(
        config.weeklyRemainingRatio
        ?? config.quota?.weeklyRemainingRatio
        ?? quotaRatios.weeklyRemainingRatio
    );

    return {
        providerType,
        uuid: String(uuid),
        customName: config.customName || cachedInstance?.name || '',
        providerWeight: config.providerWeight ?? config.weight,
        isHealthy: config.isHealthy !== false,
        isDisabled: config.isDisabled === true,
        needsRefresh: config.needsRefresh === true,
        scheduledRecoveryTime: config.scheduledRecoveryTime || null,
        available: config.available,
        hasCapacity: config.hasCapacity,
        isAtCapacity: config.isAtCapacity,
        quotaAvailable: config.quotaAvailable === false || quotaHealth?.general?.isHealthy === false
            ? false
            : config.quotaAvailable,
        fiveHourRemainingRatio,
        weeklyRemainingRatio
    };
}

function readProviderPoolsFallback() {
    const filePath = path.join(process.cwd(), 'configs', 'provider_pools.json');
    try {
        if (!fs.existsSync(filePath)) return {};
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        logger.warn('[API Potluck] Failed to read provider pools for credential groups:', error.message);
        return {};
    }
}

async function loadCodexCredentialCatalog() {
    let providerStatus = null;
    try {
        const { getProviderPoolManager } = await import('../../services/service-manager.js');
        providerStatus = getProviderPoolManager()?.providerStatus || null;
    } catch (error) {
        logger.warn('[API Potluck] Provider pool manager unavailable for credential groups:', error.message);
    }

    const pools = providerStatus && typeof providerStatus === 'object'
        ? providerStatus
        : readProviderPoolsFallback();
    const usageCache = readFreshUsageCacheSync();
    const credentials = [];

    for (const [poolType, providers] of Object.entries(pools || {})) {
        if (!isCodexProviderType(poolType) || !Array.isArray(providers)) continue;
        for (const provider of providers) {
            const providerType = provider?.type || provider?.providerType || poolType;
            const credential = normalizeCodexCredential(providerType, provider, usageCache);
            if (credential) credentials.push(credential);
        }
    }

    return credentials;
}

function getCredentialRef(providerType, uuid) {
    return hashSecret(`${providerType || 'openai-codex-oauth'}:${uuid || ''}`);
}

function buildCredentialRoutingOptions(credentials) {
    const providerEmailIndex = loadProviderEmailIndex();
    return {
        credentials: (credentials || []).map(credential => ({
            credentialRef: getCredentialRef(credential.providerType, credential.uuid),
            accountEmail: providerEmailIndex.get(`${credential.providerType}:${credential.uuid}`) || '',
            customName: sanitizeProviderName(credential.customName),
            ...getProviderUiAvailability(credential)
        }))
    };
}

function readProviderCredentialEmail(provider) {
    const credPath = provider?.CODEX_OAUTH_CREDS_FILE_PATH;
    if (!credPath) return '';
    const resolvedPath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    if (!fs.existsSync(resolvedPath)) return '';
    try {
        const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        return extractCodexCredentialIdentity(data).codexEmail || '';
    } catch {
        return '';
    }
}

function loadProviderEmailIndex() {
    const index = new Map();

    try {
        const filePath = path.join(process.cwd(), 'configs', 'provider_pools.json');
        if (fs.existsSync(filePath)) {
            const providerPools = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (const [providerType, providers] of Object.entries(providerPools || {})) {
                if (!Array.isArray(providers)) continue;
                for (const provider of providers) {
                    if (!provider?.uuid) continue;
                    const email = provider.codexEmail || readProviderCredentialEmail(provider);
                    if (!email) continue;
                    index.set(`${providerType}:${provider.uuid}`, email);
                }
            }
        }
    } catch (error) {
        logger.warn('[API Potluck] Failed to load provider pool email index:', error.message);
    }

    try {
        const cachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
        if (!fs.existsSync(cachePath)) return index;
        const usageCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const [providerType, providerUsage] of Object.entries(usageCache?.providers || {})) {
            const instances = Array.isArray(providerUsage?.instances) ? providerUsage.instances : [];
            for (const instance of instances) {
                const email = instance?.usage?.user?.email || instance?.usage?.user?.label || instance?.codexEmail;
                if (!instance?.uuid || !email) continue;
                index.set(`${providerType}:${instance.uuid}`, email);
            }
        }
    } catch (error) {
        logger.warn('[API Potluck] Failed to load usage cache email index:', error.message);
    }

    return index;
}

function enrichAccountWithEmail(account, providerEmailIndex) {
    if (!account || account.accountEmail) return account;
    const provider = account.provider || null;
    const candidates = Array.isArray(account.providerUuids) && account.providerUuids.length > 0
        ? account.providerUuids
        : [account.providerUuid].filter(Boolean);
    for (const uuid of candidates) {
        const email = providerEmailIndex.get(`${provider}:${uuid}`);
        if (email) {
            account.accountEmail = email;
            break;
        }
    }
    return account;
}

function enrichPotluckStatsAccountEmails(stats) {
    const providerEmailIndex = loadProviderEmailIndex();
    if (providerEmailIndex.size === 0) return stats;

    for (const day of Object.values(stats?.usageHistory || {})) {
        for (const account of Object.values(day?.accounts || {})) {
            enrichAccountWithEmail(account, providerEmailIndex);
        }
        for (const hour of Object.values(day?.hours || {})) {
            for (const account of Object.values(hour?.accounts || {})) {
                enrichAccountWithEmail(account, providerEmailIndex);
            }
        }
    }
    return stats;
}

function buildLedgerKeyHashLookup(targetKeyId = null) {
    const lookup = new Map();
    for (const identity of getLedgerKeyIdentities()) {
        if (targetKeyId && identity.keyId !== targetKeyId) continue;
        for (const hash of identity.hashes || []) lookup.set(hash, identity.keyId);
    }
    return lookup;
}

async function loadLedgerRangeStatsForRange(range, conversionModel, options = {}) {
    const startedAt = performance.now();
    const ledgerDailyDir = path.join(process.cwd(), 'configs', 'permanent-usage-ledger', 'daily');
    const dates = resolveRangeDates(range, {
        ledgerDailyDir,
        from: options.from,
        to: options.to
    });
    const includeKeySummaries = Boolean(options.includeKeySummaries || options.targetKeyId);
    const keyHashToId = includeKeySummaries ? buildLedgerKeyHashLookup(options.targetKeyId) : null;
    let extraRows = [];
    let keySummaryRows = [];
    const sqliteStartedAt = performance.now();
    try {
        const metadataPath = path.join(process.cwd(), 'configs', 'api-potluck-keys.json');
        const sqlitePath = process.env.USAGE_EVENT_DB_PATH
            || path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite');
        const store = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const ledgerDateSet = new Set(listLedgerDates(ledgerDailyDir));
        const today = getBeijingDateKey();
        const missingCandidates = dates.filter(date => date === today || !ledgerDateSet.has(date));
        const sqliteRows = readSqliteRowsForDates(sqlitePath, includeKeySummaries ? dates : missingCandidates, store);
        extraRows = sqliteRows.filter(row => missingCandidates.includes(row.date));
        keySummaryRows = sqliteRows;
    } catch {
        extraRows = [];
    }
    const sqliteMs = Math.round(performance.now() - sqliteStartedAt);
    const statsStartedAt = performance.now();
    const stats = await readLedgerRangeStats({
        ledgerDailyDir,
        dates,
        conversionModel,
        keyHashToId,
        includeKeySummaries,
        includeKeyModels: Boolean(options.targetKeyId),
        targetKeyId: options.targetKeyId || null,
        keyDailyLimit: options.targetKeyId ? Number.POSITIVE_INFINITY : 35,
        extraRows,
        keySummaryRows
    });
    if (stats.keySummaries) {
        stats.keySummaries = Object.fromEntries(
            Object.entries(stats.keySummaries).map(([keyId, summary]) => [hashSecret(keyId), summary])
        );
    }
    const ledgerDates = listLedgerDates(ledgerDailyDir);
    const today = getBeijingDateKey();
    const result = {
        range,
        from: dates[0] || today,
        to: dates[dates.length - 1] || today,
        bounds: {
            from: ledgerDates[0] || today,
            to: today
        },
        dates,
        source: 'ledger',
        ...stats
    };
    logger.info(`[API Potluck] range-stats range=${range} dates=${dates.length} includeKeys=${includeKeySummaries} keySource=${stats.keySummarySource || 'ledger-scan'} elapsedMs=${Math.round(performance.now() - startedAt)} sqliteMs=${sqliteMs} aggregationMs=${Math.round(performance.now() - statsStartedAt)}`);
    return result;
}

function readReconciliationLatest() {
    try {
        const filePath = path.join(process.cwd(), 'configs', 'permanent-usage-ledger', 'reconciliation', 'latest.json');
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn('[API Potluck] Failed to read reconciliation latest:', error.message);
        return null;
    }
}

function enrichAccountUsageSummaryEmails(summary) {
    const providerEmailIndex = loadProviderEmailIndex();
    if (providerEmailIndex.size === 0) return summary;
    for (const account of summary?.accounts || []) {
        enrichAccountWithEmail(account, providerEmailIndex);
    }
    return summary;
}

/**
 * 验证管理员 Token
 * @param {http.IncomingMessage} req
 * @returns {Promise<boolean>}
 */
async function checkAdminAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }
    
    // 动态导入 ui-manager 中的 token 验证逻辑
    try {
        const { existsSync, readFileSync } = await import('fs');
        const { promises: fs } = await import('fs');
        const path = await import('path');
        
        const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');
        
        if (!existsSync(TOKEN_STORE_FILE)) {
            return false;
        }
        
        const content = readFileSync(TOKEN_STORE_FILE, 'utf8');
        const tokenStore = JSON.parse(content);
        const token = authHeader.substring(7);
        const tokenInfo = tokenStore.tokens[token];
        
        if (!tokenInfo) {
            return false;
        }
        
        // 检查是否过期
        if (Date.now() > tokenInfo.expiryTime) {
            return false;
        }
        
        return true;
    } catch (error) {
        logger.error('[API Potluck] Auth check error:', error.message);
        return false;
    }
}

/**
 * 处理 Potluck 管理 API 请求
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handlePotluckApiRoutes(method, path, req, res) {
    // 只处理 /api/potluck 开头的请求
    if (!path.startsWith('/api/potluck')) {
        return false;
    }
    logger.info('[API Potluck] Handling request:', method, path);
    
    // 验证管理员权限
    const isAuthed = await checkAdminAuth(req);
    if (!isAuthed) {
        sendJson(res, 401, { 
            success: false, 
            error: { message: '未授权：请先登录', code: 'UNAUTHORIZED' } 
        });
        return true;
    }

    try {
        // GET /api/potluck/stats?detail=summary|history|full - 获取分层统计信息
        if (method === 'GET' && path === '/api/potluck/stats') {
            const detail = getRequestDetailOptions(req);
            const costOptions = getRequestCostOptions(req);
            const statsOptions = detail === 'summary'
                ? { ...costOptions, compactHistory: true, compactAccounts: true }
                : detail === 'history'
                    ? { ...costOptions, compactAccounts: true }
                    : costOptions;
            const rawStats = await getCachedStats(statsOptions);
            const displayStats = overlayDisplayUsageOnStats(
                rawStats,
                await loadDisplayUsageSnapshots(costOptions.conversionModel)
            );
            const stats = enrichPotluckStatsAccountEmails(shapeStatsByDetail(displayStats, detail));
            sendJson(res, 200, { success: true, data: stats });
            return true;
        }

        // GET /api/potluck/credential-groups/options - 路由编辑弹窗所需的最小选项
        if (method === 'GET' && path === '/api/potluck/credential-groups/options') {
            const credentials = await loadCodexCredentialCatalog();
            sendJson(res, 200, { success: true, data: buildCredentialRoutingOptions(credentials) });
            return true;
        }

        // GET /api/potluck/overview - 管理页首屏摘要与 Key 列表的合并读取
        if (method === 'GET' && path === '/api/potluck/overview') {
            const overview = await getCachedOverview(getRequestCostOptions(req));
            sendJson(res, 200, { success: true, data: overview });
            return true;
        }

        // GET /api/potluck/range-stats - 从 ledger 预聚合读取区间统计（管理页分布数据源）
        if (method === 'GET' && path === '/api/potluck/range-stats') {
            const url = new URL(req.url || '', 'http://localhost');
            const range = ['total', '30d', '7d', 'today', 'custom'].includes(url.searchParams.get('range'))
                ? url.searchParams.get('range')
                : '7d';
            const conversionModel = url.searchParams.get('conversionModel') || undefined;
            const data = await loadLedgerRangeStatsForRange(range, conversionModel, {
                from: range === 'custom' ? url.searchParams.get('from') : undefined,
                to: range === 'custom' ? url.searchParams.get('to') : undefined,
                includeKeySummaries: url.searchParams.get('includeKeys') === '1'
            });
            sendJson(res, 200, { success: true, data });
            return true;
        }

        // GET /api/potluck/reconciliation - 获取最近一次每日用量对账结果
        if (method === 'GET' && path === '/api/potluck/reconciliation') {
            const latest = readReconciliationLatest();
            sendJson(res, 200, {
                success: true,
                data: { available: latest !== null, result: latest }
            });
            return true;
        }

        // GET /api/potluck/account-usage-summary - 获取账号维度真实用量摘要
        if (method === 'GET' && path === '/api/potluck/account-usage-summary') {
            const summary = enrichAccountUsageSummaryEmails(await getAccountUsageSummary());
            sendJson(res, 200, { success: true, data: summary });
            return true;
        }

        // POST /api/potluck/stats/reset-tokens - 重置全部 Key 的 Token 统计
        if (method === 'POST' && path === '/api/potluck/stats/reset-tokens') {
            const result = await resetAllTokenStats();
            clearStatsCache();
            sendManagementMutationResponse(res, {
                result,
                message: `已重置 ${result.updated}/${result.total} 个 Key 的 Token 统计`,
                data: result
            });
            return true;
        }

        // GET /api/potluck/keys - 获取所有 Key 列表
        if (method === 'GET' && path === '/api/potluck/keys') {
            const costOptions = getRequestCostOptions(req);
            const overview = await getCachedOverview(costOptions);
            sendJson(res, 200, { success: true, data: overview });
            return true;
        }

        // POST /api/potluck/keys/apply-limit - 批量应用每日限额到所有 Key
        if (method === 'POST' && path === '/api/potluck/keys/apply-limit') {
            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
            const { dailyLimit } = body;
            
            if (dailyLimit === undefined || typeof dailyLimit !== 'number' || dailyLimit < 0) {
                sendJson(res, 400, { success: false, error: { message: 'dailyLimit 必须是一个非负数，0 表示不限量' } });
                return true;
            }
            
            const result = await applyDailyLimitToAllKeys(dailyLimit);
            sendManagementMutationResponse(res, {
                result,
                message: `已将每日限额 ${formatDailyLimitMessage(dailyLimit)} 应用到 ${result.updated}/${result.total} 个 Key`,
                data: result
            });
            return true;
        }

        // POST /api/potluck/keys - 创建新 Key
        if (method === 'POST' && path === '/api/potluck/keys') {
            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
            const { name, dailyLimit } = body;
            const keyData = await createKey(name, dailyLimit);
            sendManagementMutationResponse(res, {
                result: keyData,
                message: 'API Key 创建成功',
                data: compactKeyManagementMutationData(keyData),
                successStatusCode: 201
            });
            return true;
        }

        // 处理带 keyId 的路由
        const keyIdMatch = path.match(/^\/api\/potluck\/keys\/([^\/]+)(\/.*)?$/);
        if (keyIdMatch) {
            const keyId = resolveManagementKeyId(decodeURIComponent(keyIdMatch[1]));
            const subPath = keyIdMatch[2] || '';

            if (method === 'GET' && subPath === '/detail') {
                const keyData = await getKey(keyId, getRequestCostOptions(req));
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, {
                    success: true,
                    data: {
                        id: hashSecret(keyId),
                        maskedKey: keyData.maskedKey || `${keyId.substring(0, 12)}...${keyId.substring(keyId.length - 4)}`,
                        secret: keyId
                    }
                });
                return true;
            }

            if (method === 'GET' && subPath === '/range-stats') {
                const existingKey = await getKey(keyId, { summaryOnly: true, compactCosts: true });
                if (!existingKey) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                const url = new URL(req.url || '', 'http://localhost');
                const conversionModel = url.searchParams.get('conversionModel') || undefined;
                // 固定范围交给服务端按北京时间解析；不带 range 时兼容原有 from/to 自定义调用。
                const requestedRange = url.searchParams.get('range');
                const detailRange = ['total', '30d', '7d', 'today'].includes(requestedRange)
                    ? requestedRange
                    : 'custom';
                const data = await loadLedgerRangeStatsForRange(detailRange, conversionModel, {
                    from: detailRange === 'custom' ? url.searchParams.get('from') : undefined,
                    to: detailRange === 'custom' ? url.searchParams.get('to') : undefined,
                    targetKeyId: keyId
                });
                sendJson(res, 200, {
                    success: true,
                    data: {
                        ...data,
                        keySummary: data.keySummaries?.[hashSecret(keyId)] || null,
                        keySummaries: undefined
                    }
                });
                return true;
            }

            // GET /api/potluck/keys/:keyId - 获取单个 Key 详情
            if (method === 'GET' && !subPath) {
                const keyData = await getKey(keyId, getRequestCostOptions(req));
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { success: true, data: sanitizeKeyManagementData(keyData) });
                return true;
            }

            // DELETE /api/potluck/keys/:keyId - 删除 Key
            if (method === 'DELETE' && !subPath) {
                const deleted = await deleteKey(keyId);
                if (!deleted) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: deleted,
                    message: 'Key 删除成功',
                    data: compactKeyManagementMutationData(deleted)
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/limit - 更新每日限额
            if (method === 'PUT' && subPath === '/limit') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const { dailyLimit } = body;
                
                if (typeof dailyLimit !== 'number' || dailyLimit < 0) {
                    sendJson(res, 400, { 
                        success: false, 
                        error: { message: '无效的每日限额值' } 
                    });
                    return true;
                }

                const keyData = await updateKeyLimit(keyId, dailyLimit);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: '每日限额更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/reset - 重置当天调用次数
            if (method === 'POST' && subPath === '/reset') {
                const keyData = await resetKeyUsage(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: '使用量重置成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/reset-tokens - 重置 Token 统计
            if (method === 'POST' && subPath === '/reset-tokens') {
                const keyData = await resetKeyTokenStats(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: 'Token 统计重置成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/toggle - 切换启用/禁用状态
            if (method === 'POST' && subPath === '/toggle') {
                const keyData = await toggleKey(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: `Key 已成功${keyData.enabled ? '启用' : '禁用'}`,
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/name - 更新 Key 名称
            if (method === 'PUT' && subPath === '/name') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const { name } = body;
                
                if (!name || typeof name !== 'string') {
                    sendJson(res, 400, { 
                        success: false, 
                        error: { message: '无效的名称值' } 
                    });
                    return true;
                }

                const keyData = await updateKeyName(keyId, name);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: '名称更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/routing - 更新 Codex 凭据路由
            if (method === 'PUT' && subPath === '/routing') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                let routing = body || {};
                if (routing.routingMode === 'fixed' && routing.fixedCredential?.credentialRef && !routing.fixedCredential?.uuid) {
                    const credentials = await loadCodexCredentialCatalog();
                    const matched = credentials.find(credential => getCredentialRef(
                        credential.providerType,
                        credential.uuid
                    ) === routing.fixedCredential.credentialRef);
                    if (!matched) {
                        sendJson(res, 400, { success: false, error: { message: '未找到指定凭据', code: 'FIXED_CREDENTIAL_NOT_FOUND' } });
                        return true;
                    }
                    routing = {
                        ...routing,
                        fixedCredential: {
                            providerType: matched.providerType,
                            uuid: matched.uuid
                        }
                    };
                }
                if (routing.routingMode === 'restricted') {
                    const refs = routing.credentialRefs;
                    if (!Array.isArray(refs) || refs.length < 2 || refs.length > 5
                        || refs.some(ref => typeof ref !== 'string' || !ref)
                        || new Set(refs).size !== refs.length) {
                        sendJson(res, 400, { success: false, error: { message: '请选择 2–5 份不同的 Codex 凭据', code: 'RESTRICTED_CREDENTIALS_INVALID' } });
                        return true;
                    }
                    const credentials = await loadCodexCredentialCatalog();
                    const byRef = new Map(credentials
                        .filter(credential => credential.providerType === 'openai-codex-oauth')
                        .map(credential => [getCredentialRef(credential.providerType, credential.uuid), credential]));
                    if (refs.some(ref => !byRef.has(ref))) {
                        sendJson(res, 400, { success: false, error: { message: '限定池包含不存在的 Codex 凭据', code: 'RESTRICTED_CREDENTIAL_NOT_FOUND' } });
                        return true;
                    }
                    routing = {
                        ...routing,
                        restrictedCredentialUuids: refs.map(ref => byRef.get(ref).uuid)
                    };
                }
                const previous = await getKey(keyId, { summaryOnly: true, compactCosts: true });
                if (!previous) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                const previousRouting = {
                    routingMode: previous.routingMode || 'pool',
                    fixedCredential: previous.fixedCredential || null,
                    restrictedCredentialUuids: previous.restrictedCredentialUuids || [],
                    manualLock: previous.manualLock === true
                };
                const keyData = await updateKeyRouting(keyId, routing);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                if ((routing.routingMode === 'restricted' || previousRouting.routingMode === 'restricted')
                    && keyData.persistencePending === true) {
                    await updateKeyRouting(keyId, previousRouting);
                    sendJson(res, 503, { success: false, error: {
                        message: 'Key 路由尚未持久化，限定池未应用',
                        code: 'KEY_ROUTING_PERSISTENCE_PENDING'
                    } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: 'Key 路由更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            if (method === 'PUT' && subPath === '/edge-admission') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const keyData = await updateKeyEdgeAdmission(keyId, body || {});
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: 'Edge Admission 配置更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/regenerate - 重新生成 Key
            if (method === 'POST' && subPath === '/regenerate') {
                const result = await regenerateKey(keyId);
                if (!result) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result,
                    message: 'Key 重新生成成功',
                    data: {
                        oldKeyRef: hashSecret(result.oldKey),
                        newKeyRef: hashSecret(result.newKey),
                        keyData: compactKeyManagementMutationData(result.keyData)
                    }
                });
                return true;
            }
        }

        // 未匹配的 potluck 路由
        sendJson(res, 404, { success: false, error: { message: '未找到 Potluck API 端点' } });
        return true;

    } catch (error) {
        if (error?.code === 'INVALID_KEY_ROUTING') {
            sendJson(res, 400, {
                success: false,
                error: { message: error.message, code: error.code }
            });
            return true;
        }
        if (error?.code === 'INVALID_DATE_RANGE') {
            sendJson(res, 400, {
                success: false,
                error: { message: error.message, code: error.code }
            });
            return true;
        }
        logger.error('[API Potluck] API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: error.message || '内部服务器错误' }
        });
        return true;
    }
}

/**
 * 从请求中提取 Potluck API Key
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @returns {string|null}
 */
function extractApiKeyFromRequest(req) {
    // 1. 检查 Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith(KEY_PREFIX)) {
            return token;
        }
    }

    // 2. 检查 x-api-key header
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
        return xApiKey;
    }

    return null;
}

/**
 * 处理用户端 API 请求 - 用户通过自己的 API Key 查询使用量
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handlePotluckUserApiRoutes(method, path, req, res) {
    // 只处理 /api/potluckuser 开头的请求
    if (!path.startsWith('/api/potluckuser')) {
        return false;
    }
    logger.info('[API Potluck User] Handling request:', method, path);

    try {
        // 从请求中提取 API Key
        const apiKey = extractApiKeyFromRequest(req);
        
        if (!apiKey) {
            sendJson(res, 401, {
                success: false,
                error: {
                    message: '需要 API Key。请在 Authorization 标头 (Bearer maki_xxx) 或 x-api-key 标头中提供您的 API Key。',
                    code: 'API_KEY_REQUIRED'
                }
            });
            return true;
        }

        // 验证 API Key
        const validation = await validateKey(apiKey);
        
        if (!validation.valid && validation.reason !== 'quota_exceeded') {
            const errorMessages = {
                'invalid_format': 'API Key 格式无效',
                'not_found': '未找到 API Key',
                'disabled': 'API Key 已禁用'
            };
            
            sendJson(res, 401, {
                success: false,
                error: {
                    message: errorMessages[validation.reason] || '无效的 API Key',
                    code: validation.reason
                }
            });
            return true;
        }

        // GET /api/potluckuser/usage - 获取当前用户的使用量信息
        if (method === 'GET' && path === '/api/potluckuser/usage') {
            const keyData = await getKey(apiKey, { compactUserHistory: true, compactCosts: true });
            
            if (!keyData) {
                sendJson(res, 404, {
                    success: false,
                    error: { message: '未找到 Key', code: 'KEY_NOT_FOUND' }
                });
                return true;
            }

            // 计算使用百分比
            const usagePercent = keyData.dailyLimit > 0
                ? Math.round((keyData.todayUsage / keyData.dailyLimit) * 100)
                : 0;
            const todayDate = getBeijingDateKey(new Date());
            const todayCost = keyData.usageHistory?.[todayDate]?.summary?.cost || {};

            // 返回用户友好的使用量信息（隐藏敏感信息）
            sendJson(res, 200, {
                success: true,
                data: {
                    name: keyData.name,
                    enabled: keyData.enabled,
                    usage: {
                        today: keyData.todayUsage,
                        limit: keyData.dailyLimit,
                        remaining: Math.max(0, keyData.dailyLimit - keyData.todayUsage),
                        percent: usagePercent,
                        resetDate: keyData.lastResetDate,
                        promptTokens: keyData.todayPromptTokens || 0,
                        completionTokens: keyData.todayCompletionTokens || 0,
                        totalTokens: keyData.todayTotalTokens || 0,
                        cachedTokens: keyData.todayCachedTokens || 0,
                        qps: keyData.qps || 0,
                        tps: keyData.tps || 0,
                        rpm: keyData.rpm || 0,
                        maxQps: keyData.maxQps || 0,
                        maxTps: keyData.maxTps || 0,
                        maxRpm: keyData.maxRpm || 0,
                        cost: compactUserCost(todayCost)
                    },
                    total: keyData.totalUsage,
                    cost: compactUserCost(keyData.cost),
                    tokens: {
                        prompt: keyData.totalPromptTokens || 0,
                        completion: keyData.totalCompletionTokens || 0,
                        total: keyData.totalTokens || 0,
                        cached: keyData.totalCachedTokens || 0
                    },
                    lastUsedAt: keyData.lastUsedAt,
                    createdAt: keyData.createdAt,
                    usageHistory: keyData.usageHistory || {},
                    // 显示部分遮蔽的 Key ID

                    maskedKey: `${apiKey.substring(0, 12)}...${apiKey.substring(apiKey.length - 4)}`
                }
            });
            return true;
        }

        // 未匹配的用户端路由
        sendJson(res, 404, {
            success: false,
            error: { message: '未找到用户 API 端点' }
        });
        return true;

    } catch (error) {
        logger.error('[API Potluck] User API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: error.message || '内部服务器错误' }
        });
        return true;
    }
}
