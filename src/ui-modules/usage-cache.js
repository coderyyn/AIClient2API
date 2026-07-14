import { atomicWriteFile } from '../utils/file-lock.js';
import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');
export const DEFAULT_USAGE_CACHE_TTL_MS = 60 * 60 * 1000;

function getCachedInstancesByUuid(providerCache = {}) {
    const instances = Array.isArray(providerCache.instances) ? providerCache.instances : [];
    return new Map(instances.filter(inst => inst?.uuid).map(inst => [inst.uuid, inst]));
}

function recalculateProviderCounts(providerData = {}) {
    const instances = Array.isArray(providerData.instances) ? providerData.instances : [];
    providerData.totalCount = instances.length;
    providerData.successCount = instances.filter(inst => inst?.success).length;
    providerData.errorCount = instances.filter(inst => !inst?.success).length;
    return providerData;
}

function mergeInstanceWithLastSuccessfulUsage(incomingInstance, cachedByUuid, cachedAt) {
    if (incomingInstance?.success || !incomingInstance?.error) {
        return incomingInstance;
    }

    const cachedInstance = cachedByUuid.get(incomingInstance.uuid);
    if (!cachedInstance?.success || !cachedInstance.usage) {
        return incomingInstance;
    }

    return {
        ...cachedInstance,
        name: incomingInstance.name || cachedInstance.name,
        codexAccountKey: incomingInstance.codexAccountKey || cachedInstance.codexAccountKey || null,
        codexAccountId: incomingInstance.codexAccountId || cachedInstance.codexAccountId || null,
        codexEmail: incomingInstance.codexEmail || cachedInstance.codexEmail || null,
        codexQuotaHealth: incomingInstance.codexQuotaHealth || cachedInstance.codexQuotaHealth || null,
        configFilePath: incomingInstance.configFilePath || cachedInstance.configFilePath || null,
        isHealthy: incomingInstance.isHealthy,
        isDisabled: incomingInstance.isDisabled,
        success: true,
        error: null,
        staleUsage: true,
        lastRefreshError: incomingInstance.error,
        lastSuccessfulUsageAt: cachedAt || null
    };
}

function mergeProviderWithLastSuccessfulUsage(providerType, incomingProviderData = {}, cachedProviderData = {}, cachedAt) {
    if (incomingProviderData.error && Array.isArray(cachedProviderData?.instances) && cachedProviderData.instances.length > 0) {
        return {
            ...cachedProviderData,
            providerType,
            fromCache: true,
            stale: true,
            lastRefreshError: incomingProviderData.error,
            lastSuccessfulUsageAt: cachedAt || null
        };
    }

    if (!Array.isArray(incomingProviderData.instances)) {
        return incomingProviderData;
    }

    const cachedByUuid = getCachedInstancesByUuid(cachedProviderData);
    const instances = incomingProviderData.instances.map(instance =>
        mergeInstanceWithLastSuccessfulUsage(instance, cachedByUuid, cachedAt)
    );

    return recalculateProviderCounts({
        ...incomingProviderData,
        instances
    });
}

async function mergeUsageDataWithExistingLastSuccessfulUsage(usageData) {
    const existingCache = await readUsageCache({ maxAgeMs: null, allowStale: true });
    if (!existingCache?.providers || !usageData?.providers) {
        return usageData;
    }

    const mergedProviders = {};
    for (const [providerType, incomingProviderData] of Object.entries(usageData.providers)) {
        mergedProviders[providerType] = mergeProviderWithLastSuccessfulUsage(
            providerType,
            incomingProviderData,
            existingCache.providers?.[providerType],
            existingCache.timestamp || null
        );
    }

    return {
        ...usageData,
        providers: {
            ...usageData.providers,
            ...mergedProviders
        }
    };
}

function isUsageCacheFresh(cache, { maxAgeMs = DEFAULT_USAGE_CACHE_TTL_MS, now = new Date() } = {}) {
    if (maxAgeMs === null || maxAgeMs === undefined) {
        return true;
    }

    const cachedAt = Date.parse(cache?.timestamp || '');
    if (!Number.isFinite(cachedAt)) {
        return false;
    }

    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs)) {
        return false;
    }

    return nowMs - cachedAt <= maxAgeMs;
}

/**
 * 读取用量缓存文件
 * @param {Object} [options] - 缓存读取选项
 * @param {number|null} [options.maxAgeMs=DEFAULT_USAGE_CACHE_TTL_MS] - 最大缓存年龄；null 表示不做 TTL 判断
 * @param {Date|string|number} [options.now] - 测试用当前时间
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
export async function readUsageCache(options = {}) {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            const cache = JSON.parse(content);
            if (!isUsageCacheFresh(cache, options)) {
                if (options.allowStale) {
                    logger.info('[Usage Cache] Returning stale usage data as last-known fallback');
                    return { ...cache, stale: true };
                }
                logger.info('[Usage Cache] Cached usage data is stale, ignoring cache');
                return null;
            }
            return cache;
        }
        return null;
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 写入用量缓存文件
 * @param {Object} usageData - 用量数据
 */
export async function writeUsageCache(usageData) {
    try {
        const safeUsageData = await mergeUsageDataWithExistingLastSuccessfulUsage(usageData);
        await atomicWriteFile(USAGE_CACHE_FILE, JSON.stringify(safeUsageData, null, 2), { encoding: 'utf8', mode: 0o600 });
        logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
export async function readProviderUsageCache(providerType, options = {}) {
    const cache = await readUsageCache(options);
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true,
            stale: cache.stale === true
        };
    }
    return null;
}

/**
 * 更新特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
export async function updateProviderUsageCache(providerType, usageData) {
    let cache = await readUsageCache({ maxAgeMs: null });
    if (!cache) {
        cache = {
            timestamp: new Date().toISOString(),
            providers: {}
        };
    }
    cache.providers[providerType] = usageData;
    cache.timestamp = new Date().toISOString();
    await writeUsageCache(cache);
}
