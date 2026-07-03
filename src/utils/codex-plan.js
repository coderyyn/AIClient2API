import fs from 'fs';
import path from 'path';
import { MODEL_PROVIDER } from './constants.js';

const DEFAULT_USAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_USAGE_CACHE_SNAPSHOT_TTL_MS = 5 * 1000;
const ALLOWED_CODEX_PLANS = new Set(['pro', 'plus']);
let usageCacheSnapshot = null;

function isCodexProviderType(providerType) {
    return providerType === MODEL_PROVIDER.CODEX_API || providerType?.startsWith(`${MODEL_PROVIDER.CODEX_API}-`);
}

function isUsageCacheFresh(cache, maxAgeMs = DEFAULT_USAGE_CACHE_TTL_MS) {
    const cachedAt = Date.parse(cache?.timestamp || '');
    return Number.isFinite(cachedAt) && Date.now() - cachedAt <= maxAgeMs;
}

export function readFreshUsageCacheSync(maxAgeMs = DEFAULT_USAGE_CACHE_TTL_MS) {
    const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
    const now = Date.now();
    try {
        const fileStat = fs.statSync(usageCachePath);
        if (
            usageCacheSnapshot
            && usageCacheSnapshot.path === usageCachePath
            && usageCacheSnapshot.maxAgeMs === maxAgeMs
            && usageCacheSnapshot.mtimeMs === fileStat.mtimeMs
            && usageCacheSnapshot.size === fileStat.size
            && now - usageCacheSnapshot.loadedAt <= DEFAULT_USAGE_CACHE_SNAPSHOT_TTL_MS
            && isUsageCacheFresh(usageCacheSnapshot.cache, maxAgeMs)
        ) {
            return usageCacheSnapshot.cache;
        }

        const cache = JSON.parse(fs.readFileSync(usageCachePath, 'utf8'));
        if (!isUsageCacheFresh(cache, maxAgeMs)) {
            usageCacheSnapshot = null;
            return null;
        }

        usageCacheSnapshot = {
            path: usageCachePath,
            maxAgeMs,
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            loadedAt: now,
            cache
        };
        return cache;
    } catch {
        usageCacheSnapshot = null;
        return null;
    }
}

export function normalizeCodexPlan(plan) {
    if (plan === undefined || plan === null || plan === '') return 'unknown';
    const value = String(plan).trim().toLowerCase();
    if (!value) return 'unknown';
    if (/\bfree\b/.test(value)) return 'free';
    if (/\bplus\b/.test(value) || value === '+') return 'plus';
    if (/\bpro\b/.test(value) || value.includes('pro+')) return 'pro';
    return 'unknown';
}

export function isCodexPlanAllowed(plan) {
    return ALLOWED_CODEX_PLANS.has(normalizeCodexPlan(plan));
}

export function getCachedCodexUsageInstance(providerType, uuid, usageCache) {
    if (!uuid || !usageCache?.providers) return null;

    const providerCache = usageCache.providers[providerType]
        || (isCodexProviderType(providerType) ? usageCache.providers[MODEL_PROVIDER.CODEX_API] : null);
    const instances = Array.isArray(providerCache?.instances) ? providerCache.instances : [];
    return instances.find(instance => {
        const instanceUuid = instance?.uuid || instance?.config?.uuid || instance?.providerUuid;
        return instanceUuid === uuid;
    }) || null;
}

export function getCodexPlanFromUsage(usage) {
    const candidates = [
        usage?.summary?.plan,
        usage?.summary?.planType,
        usage?.plan_type,
        usage?.planType,
        usage?.raw?.plan_type,
        usage?.raw?.planType
    ];

    for (const candidate of candidates) {
        const normalized = normalizeCodexPlan(candidate);
        if (normalized !== 'unknown') {
            return normalized;
        }
    }
    return 'unknown';
}

export function getCodexPlanFromProviderConfig(config) {
    const candidates = [
        config?.lastKnownCodexPlan,
        config?.codexPlan,
        config?.codexAccountPlan,
        config?.plan,
        config?.planType
    ];

    for (const candidate of candidates) {
        const normalized = normalizeCodexPlan(candidate);
        if (normalized !== 'unknown') {
            return normalized;
        }
    }
    return 'unknown';
}

export function getCodexPlanStatusForProvider(providerType, uuid, usageCache, providerConfig = null) {
    const instance = getCachedCodexUsageInstance(providerType, uuid, usageCache);
    const usagePlan = getCodexPlanFromUsage(instance?.usage);
    const plan = usagePlan !== 'unknown'
        ? usagePlan
        : getCodexPlanFromProviderConfig(providerConfig);
    return {
        plan,
        allowed: isCodexPlanAllowed(plan),
        hasUsage: Boolean(instance?.usage),
        source: usagePlan !== 'unknown' ? 'usage' : (plan !== 'unknown' ? 'last_known' : 'unknown')
    };
}
