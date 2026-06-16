import { atomicWriteFile, atomicWriteFileSync } from '../../utils/file-lock.js';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';
import { RateManager } from '../../utils/rate-tracker.js';
import { getBeijingDateString } from '../../utils/common.js';

const STATS_STORE_FILE = path.join(process.cwd(), 'configs', 'model-usage-stats.json');
const DEFAULT_CONFIG = {
    persistInterval: 5000
};

let configGetter = null;
let statsStore = null;
let isDirty = false;
let isWriting = false;
let persistTimer = null;
let currentPersistInterval = DEFAULT_CONFIG.persistInterval;
let mutationVersion = 0;
let persistPromise = null;

const rateManager = new RateManager(60); // 使用 60 秒滑动窗口，更平滑
const pendingRequests = new Map();

function getTraceRequestId(requestId) {
    return requestId || 'N/A';
}

function getTracePrefix(requestId) {
    return `[Model Usage Stats][${getTraceRequestId(requestId)}]`;
}

function createEmptyUsage() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0,
        lastUsedAt: null
    };
}

function createDefaultStore() {
    return {
        updatedAt: null,
        summary: createEmptyUsage(),
        providers: {},
        accounts: {},
        daily: {} // 新增每日统计
    };
}

function createDailyUsage() {
    return {
        ...createEmptyUsage(),
        models: {},
        accounts: {}
    };
}

function createAccountStore(provider, providerUuid, providerName = null) {
    return {
        provider,
        providerUuid,
        providerName,
        summary: createEmptyUsage(),
        models: {}
    };
}

function normalizeUsageBlock(block) {
    const empty = createEmptyUsage();
    if (!block || typeof block !== 'object') return empty;
    return {
        requestCount: toNumber(block.requestCount),
        promptTokens: toNumber(block.promptTokens),
        completionTokens: toNumber(block.completionTokens),
        totalTokens: toNumber(block.totalTokens),
        cachedTokens: toNumber(block.cachedTokens),
        maxQps: toNumber(block.maxQps),
        maxRpm: toNumber(block.maxRpm),
        maxTps: toNumber(block.maxTps),
        lastUsedAt: block.lastUsedAt || null
    };
}

function normalizeStore(store) {
    const normalizedStore = {
        updatedAt: store?.updatedAt || null,
        summary: normalizeUsageBlock(store?.summary),
        providers: {},
        accounts: {},
        daily: {} // 新增每日统计
    };

    for (const [provider, providerStore] of Object.entries(store?.providers || {})) {
        normalizedStore.providers[provider] = {
            summary: normalizeUsageBlock(providerStore?.summary),
            models: {}
        };

        for (const [model, modelStore] of Object.entries(providerStore?.models || {})) {
            normalizedStore.providers[provider].models[model] = normalizeUsageBlock(modelStore);
        }
    }

    for (const [accountKey, accountStore] of Object.entries(store?.accounts || {})) {
        const [providerFromKey, uuidFromKey] = accountKey.split(':');
        normalizedStore.accounts[accountKey] = {
            provider: accountStore?.provider || providerFromKey || 'unknown',
            providerUuid: accountStore?.providerUuid || uuidFromKey || 'unknown',
            providerName: accountStore?.providerName || null,
            summary: normalizeUsageBlock(accountStore?.summary),
            models: {}
        };

        for (const [model, modelStore] of Object.entries(accountStore?.models || {})) {
            normalizedStore.accounts[accountKey].models[model] = normalizeUsageBlock(modelStore);
        }
    }

    if (store?.daily) {
        for (const [date, dailyStore] of Object.entries(store.daily)) {
            normalizedStore.daily[date] = {
                ...normalizeUsageBlock(dailyStore),
                models: {},
                accounts: {}
            };

            for (const [model, modelStore] of Object.entries(dailyStore?.models || {})) {
                normalizedStore.daily[date].models[model] = normalizeUsageBlock(modelStore);
            }

            for (const [accountKey, accountStore] of Object.entries(dailyStore?.accounts || {})) {
                const [providerFromKey, uuidFromKey] = accountKey.split(':');
                normalizedStore.daily[date].accounts[accountKey] = {
                    provider: accountStore?.provider || providerFromKey || 'unknown',
                    providerUuid: accountStore?.providerUuid || uuidFromKey || 'unknown',
                    providerName: accountStore?.providerName || null,
                    summary: normalizeUsageBlock(accountStore?.summary),
                    models: {}
                };

                for (const [model, modelStore] of Object.entries(accountStore?.models || {})) {
                    normalizedStore.daily[date].accounts[accountKey].models[model] = normalizeUsageBlock(modelStore);
                }
            }
        }
    }

    return normalizedStore;
}

function getConfig() {
    if (typeof configGetter === 'function') {
        return configGetter();
    }
    return DEFAULT_CONFIG;
}

function ensureProviderStore(provider) {
    ensureLoaded();
    if (!statsStore.providers[provider]) {
        statsStore.providers[provider] = {
            summary: createEmptyUsage(),
            models: {}
        };
    }
    return statsStore.providers[provider];
}

function ensureModelStore(provider, model) {
    const providerStore = ensureProviderStore(provider);
    if (!providerStore.models[model]) {
        providerStore.models[model] = createEmptyUsage();
    }
    return providerStore.models[model];
}

function getAccountKey(provider, providerUuid) {
    if (!provider || !providerUuid) return null;
    return `${provider}:${providerUuid}`;
}

function ensureAccountStore(provider, providerUuid, providerName = null) {
    ensureLoaded();
    const accountKey = getAccountKey(provider, providerUuid);
    if (!accountKey) return null;

    if (!statsStore.accounts[accountKey]) {
        statsStore.accounts[accountKey] = createAccountStore(provider, providerUuid, providerName);
    }

    if (providerName && !statsStore.accounts[accountKey].providerName) {
        statsStore.accounts[accountKey].providerName = providerName;
    }

    return statsStore.accounts[accountKey];
}

function ensureAccountModelStore(provider, providerUuid, providerName, model) {
    const accountStore = ensureAccountStore(provider, providerUuid, providerName);
    if (!accountStore) return null;

    if (!accountStore.models[model]) {
        accountStore.models[model] = createEmptyUsage();
    }

    return accountStore.models[model];
}

function ensureDailyStore(dateKey) {
    ensureLoaded();
    if (!statsStore.daily[dateKey]) {
        statsStore.daily[dateKey] = createDailyUsage();
    } else {
        statsStore.daily[dateKey].models = statsStore.daily[dateKey].models || {};
        statsStore.daily[dateKey].accounts = statsStore.daily[dateKey].accounts || {};
    }
    return statsStore.daily[dateKey];
}

function ensureDailyModelStore(dateKey, model) {
    const dailyStore = ensureDailyStore(dateKey);
    if (!dailyStore.models[model]) {
        dailyStore.models[model] = createEmptyUsage();
    }
    return dailyStore.models[model];
}

function ensureDailyAccountStore(dateKey, provider, providerUuid, providerName = null) {
    const accountKey = getAccountKey(provider, providerUuid);
    if (!accountKey) return null;

    const dailyStore = ensureDailyStore(dateKey);
    if (!dailyStore.accounts[accountKey]) {
        dailyStore.accounts[accountKey] = createAccountStore(provider, providerUuid, providerName);
    }

    if (providerName && !dailyStore.accounts[accountKey].providerName) {
        dailyStore.accounts[accountKey].providerName = providerName;
    }

    return dailyStore.accounts[accountKey];
}

function ensureDailyAccountModelStore(dateKey, provider, providerUuid, providerName, model) {
    const dailyAccountStore = ensureDailyAccountStore(dateKey, provider, providerUuid, providerName);
    if (!dailyAccountStore) return null;

    if (!dailyAccountStore.models[model]) {
        dailyAccountStore.models[model] = createEmptyUsage();
    }

    return dailyAccountStore.models[model];
}

function ensureLoaded() {
    if (statsStore !== null) return;

    try {
        if (existsSync(STATS_STORE_FILE)) {
            const content = readFileSync(STATS_STORE_FILE, 'utf8');
            statsStore = normalizeStore(JSON.parse(content));
            logger.info(`[Model Usage Stats] Loaded stats store: providers=${Object.keys(statsStore.providers).length}, requests=${statsStore.summary.requestCount}, totalTokens=${statsStore.summary.totalTokens}`);
        } else {
            statsStore = createDefaultStore();
            syncWriteToFile();
            logger.info('[Model Usage Stats] Created new stats store');
        }
    } catch (error) {
        logger.error('[Model Usage Stats] Failed to load stats store:', error.message);
        statsStore = createDefaultStore();
    }

    const config = getConfig();
    currentPersistInterval = config.persistInterval || DEFAULT_CONFIG.persistInterval;

    if (!persistTimer) {
        persistTimer = setInterval(() => {
            persistIfDirty();
            cleanupPendingRequests();
        }, currentPersistInterval);
        if (persistTimer.unref) {
            persistTimer.unref();
        }
        process.on('beforeExit', () => syncWriteToFile());
        process.on('SIGINT', () => { syncWriteToFile(); process.exit(0); });
        process.on('SIGTERM', () => { syncWriteToFile(); process.exit(0); });
    }
}

export function syncWriteToFile() {
    try {
        if (!statsStore || !isDirty) return;
        const dir = path.dirname(STATS_STORE_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        atomicWriteFileSync(STATS_STORE_FILE, JSON.stringify(statsStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        isDirty = false;
        logger.info('[Model Usage Stats] Sync persisted stats store');
    } catch (error) {
        logger.error('[Model Usage Stats] Sync write failed:', error.message);
    }
}

async function persistIfDirty() {
    ensureLoaded();
    if (!isDirty || statsStore === null) return;
    if (persistPromise) {
        await persistPromise;
        return;
    }

    persistPromise = (async () => {
        isWriting = true;

        try {
            const dir = path.dirname(STATS_STORE_FILE);
            if (!existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
            }

            while (isDirty) {
                const versionAtStart = mutationVersion;
                const snapshot = JSON.stringify(statsStore, null, 2);
                
                await atomicWriteFile(STATS_STORE_FILE, snapshot, { encoding: 'utf8', mode: 0o600 });

                if (mutationVersion === versionAtStart) {
                    isDirty = false;
                    logger.info(`[Model Usage Stats] Persisted stats store: version=${versionAtStart}, requests=${statsStore.summary.requestCount}, totalTokens=${statsStore.summary.totalTokens}`);
                }
            }
        } catch (error) {
            logger.error('[Model Usage Stats] Persist failed:', error.message);
        } finally {
            isWriting = false;
            persistPromise = null;
        }
    })();

    await persistPromise;
}

function markDirty() {
    ensureLoaded();
    statsStore.updatedAt = new Date().toISOString();
    mutationVersion += 1;
    isDirty = true;
}

function cleanupPendingRequests() {
    const now = Date.now();
    let removedCount = 0;
    for (const [requestId, state] of pendingRequests.entries()) {
        if (now - state.updatedAt > 10 * 60 * 1000) {
            pendingRequests.delete(requestId);
            removedCount += 1;
            logger.warn(`${getTracePrefix(requestId)} Dropped stale pending request: Provider: ${state.provider} | Model: ${state.model}`);
        }
    }
    if (removedCount > 0) {
        logger.warn(`[Model Usage Stats] Cleaned stale pending requests: count=${removedCount}`);
    }
}

function toNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function normalizeUsageCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    if (Array.isArray(candidate)) {
        const usage = candidate.reduce((merged, item) => mergeUsage(merged, normalizeUsageCandidate(item)), {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0
        });
        const hasUsage = usage.promptTokens > 0 || usage.completionTokens > 0 || usage.totalTokens > 0 || usage.cachedTokens > 0;
        return hasUsage ? usage : null;
    }

    const usage = candidate.usage || candidate.message?.usage || candidate.usageMetadata || candidate.response?.usage || null;
    const reasoningTokens = toNumber(
        candidate.completion_tokens_details?.reasoning_tokens ??
        candidate.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.thoughtsTokenCount
    );
    const promptTokens = toNumber(
        candidate.prompt_tokens ??
        usage?.prompt_tokens ??
        usage?.input_tokens ??
        usage?.promptTokenCount ??
        usage?.inputTokenCount
    );
    const completionTokens = toNumber(
        candidate.completion_tokens ??
        usage?.completion_tokens ??
        usage?.output_tokens ??
        usage?.candidatesTokenCount ??
        usage?.outputTokenCount
    ) + reasoningTokens;
    const totalTokens = toNumber(
        candidate.total_tokens ??
        usage?.total_tokens ??
        usage?.totalTokenCount
    );
    const cachedTokens = toNumber(
        candidate.cached_tokens ??
        usage?.cached_tokens ??
        candidate.prompt_tokens_details?.cached_tokens ??
        candidate.input_tokens_details?.cached_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens ??
        usage?.cache_read_input_tokens ??
        usage?.cachedContentTokenCount
    );

    const hasUsage = promptTokens > 0 || completionTokens > 0 || totalTokens > 0 || cachedTokens > 0;
    if (!hasUsage) {
        return null;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || (promptTokens + completionTokens),
        cachedTokens
    };
}

function mergeUsage(baseUsage, nextUsage) {
    if (!nextUsage) {
        return baseUsage;
    }

    return {
        promptTokens: Math.max(baseUsage.promptTokens, nextUsage.promptTokens),
        completionTokens: Math.max(baseUsage.completionTokens, nextUsage.completionTokens),
        totalTokens: Math.max(baseUsage.totalTokens, nextUsage.totalTokens || (nextUsage.promptTokens + nextUsage.completionTokens)),
        cachedTokens: Math.max(baseUsage.cachedTokens, nextUsage.cachedTokens)
    };
}

function extractUsage(...candidates) {
    return candidates.reduce((usage, candidate) => {
        const normalized = normalizeUsageCandidate(candidate);
        return mergeUsage(usage, normalized);
    }, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    });
}

function getPendingRequest(requestId, meta = {}) {
    ensureLoaded();

    if (!pendingRequests.has(requestId)) {
        pendingRequests.set(requestId, {
            requestId,
            model: meta.model || 'unknown',
            provider: meta.provider || 'unknown',
            providerUuid: meta.providerUuid || null,
            providerName: meta.providerName || null,
            fromProvider: meta.fromProvider || null,
            isStream: Boolean(meta.isStream),
            hasResponse: false,
            usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                cachedTokens: 0
            },
            updatedAt: Date.now()
        });
    }

    const state = pendingRequests.get(requestId);
    state.model = meta.model || state.model;
    state.provider = meta.provider || state.provider;
    state.providerUuid = state.providerUuid || meta.providerUuid || null;
    state.providerName = state.providerName || meta.providerName || null;
    state.fromProvider = meta.fromProvider || state.fromProvider;
    state.isStream = meta.isStream ?? state.isStream;
    state.updatedAt = Date.now();

    return state;
}

function applyUsage(target, usage, timestamp) {
    target.requestCount += 1;
    target.promptTokens += usage.promptTokens;
    target.completionTokens += usage.completionTokens;
    target.totalTokens += usage.totalTokens || (usage.promptTokens + usage.completionTokens);
    target.cachedTokens += usage.cachedTokens;
    target.lastUsedAt = timestamp;
}

function resetUsageBlockTokens(block) {
    if (!block || typeof block !== 'object') return;
    block.promptTokens = 0;
    block.completionTokens = 0;
    block.totalTokens = 0;
    block.cachedTokens = 0;
    block.maxQps = 0;
    block.maxRpm = 0;
    block.maxTps = 0;
}

function addCacheHitRatio(block) {
    if (!block || typeof block !== 'object') return;
    const promptTokens = toNumber(block.promptTokens);
    block.cacheHitRatio = promptTokens > 0 ? block.cachedTokens / promptTokens : 0;
}

function addDerivedUsageMetricsToTree(value) {
    if (!value || typeof value !== 'object') return;

    if (
        Object.prototype.hasOwnProperty.call(value, 'promptTokens') ||
        Object.prototype.hasOwnProperty.call(value, 'cachedTokens')
    ) {
        addCacheHitRatio(value);
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            addDerivedUsageMetricsToTree(child);
        }
    }
}

function resetUsageTokensInTree(value) {
    if (!value || typeof value !== 'object') return;

    if (
        Object.prototype.hasOwnProperty.call(value, 'promptTokens') ||
        Object.prototype.hasOwnProperty.call(value, 'cachedTokens')
    ) {
        resetUsageBlockTokens(value);
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            resetUsageTokensInTree(child);
        }
    }
}

export function setConfigGetter(getter) {
    configGetter = getter;
}

export function recordUnaryUsage({ requestId, model, provider, providerUuid, providerName, fromProvider, nativeResponse, clientResponse }) {
    if (!requestId) return;
    const state = getPendingRequest(requestId, { model, provider, providerUuid, providerName, fromProvider, isStream: false });
    const prevTotalTokens = state.usage.totalTokens;
    const prevCachedTokens = state.usage.cachedTokens;
    state.hasResponse = true;
    state.usage = mergeUsage(state.usage, extractUsage(nativeResponse, clientResponse));
    if (state.usage.totalTokens > prevTotalTokens || state.usage.cachedTokens > prevCachedTokens) {
        logger.info(`${getTracePrefix(requestId)} <<< Unary Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
    }
}

export function recordStreamChunkUsage({ requestId, model, provider, providerUuid, providerName, fromProvider, nativeChunk, clientChunk }) {
    if (!requestId) return;
    const state = getPendingRequest(requestId, { model, provider, providerUuid, providerName, fromProvider, isStream: true });
    const prevTotalTokens = state.usage.totalTokens;
    const prevCachedTokens = state.usage.cachedTokens;
    state.hasResponse = true;
    state.usage = mergeUsage(state.usage, extractUsage(nativeChunk, clientChunk));
    if (state.usage.totalTokens > prevTotalTokens || state.usage.cachedTokens > prevCachedTokens) {
        logger.info(`${getTracePrefix(requestId)} <<< Stream Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
    }
}

export async function finalizeRequest({ requestId, model, provider, providerUuid, providerName, fromProvider, isStream }) {
    if (!requestId) {
        logger.warn(`${getTracePrefix(null)} Skip finalize: missing requestId`);
        return false;
    }

    const state = getPendingRequest(requestId, { model, provider, providerUuid, providerName, fromProvider, isStream });
    
    // 防重逻辑：如果该请求已经处理过速率统计，则直接删除并返回
    if (state.rateRecorded) {
        pendingRequests.delete(requestId);
        return true;
    }
    state.rateRecorded = true;

    pendingRequests.delete(requestId);

    if (!state.hasResponse) {
        logger.warn(`${getTracePrefix(requestId)} Skip finalize: no response captured. Provider: ${state.provider} | Model: ${state.model}`);
        return false;
    }

    const now = new Date();
    const timestamp = now.toISOString();
    const dateKey = getBeijingDateString();
    const normalizedProvider = state.provider || provider || 'unknown';
    const normalizedModel = state.model || model || 'unknown';
    const normalizedProviderUuid = state.providerUuid || providerUuid || null;
    const normalizedProviderName = state.providerName || providerName || null;
    
    const usage = {
        promptTokens: state.usage.promptTokens,
        completionTokens: state.usage.completionTokens,
        totalTokens: state.usage.totalTokens || (state.usage.promptTokens + state.usage.completionTokens),
        cachedTokens: state.usage.cachedTokens
    };

    applyUsage(statsStore.summary, usage, timestamp);
    applyUsage(ensureProviderStore(normalizedProvider).summary, usage, timestamp);
    applyUsage(ensureModelStore(normalizedProvider, normalizedModel), usage, timestamp);

    const accountStore = ensureAccountStore(normalizedProvider, normalizedProviderUuid, normalizedProviderName);
    if (accountStore) {
        applyUsage(accountStore.summary, usage, timestamp);
        applyUsage(ensureAccountModelStore(normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel), usage, timestamp);
    }

    // 记录速率统计
    rateManager.record(`provider:${normalizedProvider}`, usage.totalTokens);
    rateManager.record(`model:${normalizedModel}`, usage.totalTokens);
    if (normalizedProviderUuid) {
        rateManager.record(`account:${normalizedProvider}:${normalizedProviderUuid}`, usage.totalTokens);
    }

    const globalRates = rateManager.getGlobalStats();
    
    // 更新持久化峰值
    const updatePeaks = (target) => {
        target.maxQps = Math.max(target.maxQps || 0, globalRates.qps);
        target.maxRpm = Math.max(target.maxRpm || 0, globalRates.rpm);
        target.maxTps = Math.max(target.maxTps || 0, globalRates.tps);
    };

    updatePeaks(statsStore.summary);
    updatePeaks(ensureProviderStore(normalizedProvider).summary);
    updatePeaks(ensureModelStore(normalizedProvider, normalizedModel));
    if (accountStore) {
        updatePeaks(accountStore.summary);
        updatePeaks(ensureAccountModelStore(normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel));
    }

    const dailyBlock = ensureDailyStore(dateKey);
    applyUsage(dailyBlock, usage, timestamp);
    applyUsage(ensureDailyModelStore(dateKey, normalizedModel), usage, timestamp);
    updatePeaks(dailyBlock);
    updatePeaks(ensureDailyModelStore(dateKey, normalizedModel));

    const dailyAccountStore = ensureDailyAccountStore(dateKey, normalizedProvider, normalizedProviderUuid, normalizedProviderName);
    if (dailyAccountStore) {
        applyUsage(dailyAccountStore.summary, usage, timestamp);
        applyUsage(ensureDailyAccountModelStore(dateKey, normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel), usage, timestamp);
        updatePeaks(dailyAccountStore.summary);
        updatePeaks(ensureDailyAccountModelStore(dateKey, normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel));
    }

    logger.info(`${getTracePrefix(requestId)} >>> Request Finalized: Provider: ${normalizedProvider} | Model: ${normalizedModel} | Prompt: ${usage.promptTokens} | Completion: ${usage.completionTokens} | Total: ${usage.totalTokens} | Cached: ${usage.cachedTokens} | Stream: ${Boolean(state.isStream)} | QPS: ${globalRates.qps}`);
    markDirty();
    await persistIfDirty();
    return true;
}

export async function getStats() {
    ensureLoaded();
    const stats = JSON.parse(JSON.stringify(statsStore));
    
    // 注入速率统计
    const globalRates = rateManager.getGlobalStats();
    stats.summary.qps = globalRates.qps;
    stats.summary.tps = globalRates.tps;
    stats.summary.rpm = globalRates.rpm;
    // 峰值取持久化值和当前内存值中的较大者
    stats.summary.maxQps = Math.max(stats.summary.maxQps || 0, globalRates.maxQps);
    stats.summary.maxTps = Math.max(stats.summary.maxTps || 0, globalRates.maxTps);
    stats.summary.maxRpm = Math.max(stats.summary.maxRpm || 0, globalRates.maxRpm);

    for (const [provider, providerStore] of Object.entries(stats.providers || {})) {
        const pRates = rateManager.getStats(`provider:${provider}`);
        providerStore.summary.qps = pRates.qps;
        providerStore.summary.tps = pRates.tps;
        providerStore.summary.rpm = pRates.rpm;
        providerStore.summary.maxQps = Math.max(providerStore.summary.maxQps || 0, pRates.maxQps);
        providerStore.summary.maxTps = Math.max(providerStore.summary.maxTps || 0, pRates.maxTps);
        providerStore.summary.maxRpm = Math.max(providerStore.summary.maxRpm || 0, pRates.maxRpm);

        for (const [model, modelStore] of Object.entries(providerStore.models || {})) {
            const mRates = rateManager.getStats(`model:${model}`);
            modelStore.qps = mRates.qps;
            modelStore.tps = mRates.tps;
            modelStore.rpm = mRates.rpm;
            modelStore.maxQps = Math.max(modelStore.maxQps || 0, mRates.maxQps);
            modelStore.maxTps = Math.max(modelStore.maxTps || 0, mRates.maxTps);
            modelStore.maxRpm = Math.max(modelStore.maxRpm || 0, mRates.maxRpm);
        }
    }

    for (const [accountKey, accountStore] of Object.entries(stats.accounts || {})) {
        const aRates = rateManager.getStats(`account:${accountKey}`);
        accountStore.summary.qps = aRates.qps;
        accountStore.summary.tps = aRates.tps;
        accountStore.summary.rpm = aRates.rpm;
        accountStore.summary.maxQps = Math.max(accountStore.summary.maxQps || 0, aRates.maxQps);
        accountStore.summary.maxTps = Math.max(accountStore.summary.maxTps || 0, aRates.maxTps);
        accountStore.summary.maxRpm = Math.max(accountStore.summary.maxRpm || 0, aRates.maxRpm);
    }

    addDerivedUsageMetricsToTree(stats);

    return stats;
}

export async function resetStats() {
    ensureLoaded();
    statsStore = createDefaultStore();
    pendingRequests.clear();
    rateManager.clear(); // 同时重置速率统计
    markDirty();
    await persistIfDirty();
    logger.warn('[Model Usage Stats] Stats store reset');
    return getStats();
}

export async function resetTokenStats() {
    ensureLoaded();

    resetUsageTokensInTree(statsStore);

    pendingRequests.clear();
    rateManager.clear(); // 同时重置速率统计
    markDirty();
    await persistIfDirty();
    logger.warn('[Model Usage Stats] Token stats reset');
    return getStats();
}
