import logger from '../utils/logger.js';

async function fetchAllProvidersUsage(...args) {
    const { getAllProvidersUsage } = await import('../ui-modules/usage-api.js');
    return getAllProvidersUsage(...args);
}

async function persistUsageCache(...args) {
    const { writeUsageCache } = await import('../ui-modules/usage-cache.js');
    return writeUsageCache(...args);
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;

function normalizeBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function normalizeInterval(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
    return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.floor(parsed)));
}

export function normalizeUsageCacheAutoRefreshConfig(config = {}) {
    const incoming = config.USAGE_CACHE_AUTO_REFRESH || {};
    return {
        enabled: normalizeBoolean(incoming.enabled, true),
        startupRun: normalizeBoolean(incoming.startupRun, true),
        interval: normalizeInterval(incoming.interval)
    };
}

export class UsageCacheAutoRefreshService {
    constructor({ config, providerPoolManager, fetchUsage = fetchAllProvidersUsage, persistUsage = persistUsageCache, log = logger } = {}) {
        this.config = config || {};
        this.providerPoolManager = providerPoolManager;
        this.fetchUsage = fetchUsage;
        this.persistUsage = persistUsage;
        this.log = log;
        this.timer = null;
        this.startupTimer = null;
        this.isRunning = false;
        this.activeRefreshPromise = null;
        this.idleWaiters = new Set();
        this.activeInterval = null;
    }

    refresh() {
        if (this.activeRefreshPromise) {
            this.log.debug('[Usage Cache Auto Refresh] Reusing active refresh');
            return this.activeRefreshPromise;
        }

        this.isRunning = true;
        this.activeRefreshPromise = (async () => {
            try {
                this.log.info('[Usage Cache Auto Refresh] Fetching fresh usage data');
                const usageData = await this.fetchUsage(this.config, this.providerPoolManager);
                await this.persistUsage(usageData);
                this.log.info('[Usage Cache Auto Refresh] Usage cache refreshed');
                return { skipped: false, usageData };
            } catch (error) {
                this.log.error('[Usage Cache Auto Refresh] Refresh failed:', error);
                return { skipped: false, error };
            } finally {
                this.isRunning = false;
                this.activeRefreshPromise = null;
                for (const resolve of this.idleWaiters) resolve();
                this.idleWaiters.clear();
            }
        })();
        return this.activeRefreshPromise;
    }

    start(interval) {
        this.clearScheduling();
        const safeInterval = normalizeInterval(interval);
        this.activeInterval = safeInterval;
        this.timer = setInterval(() => {
            this.refresh();
        }, safeInterval);
        this.log.info(`[Usage Cache Auto Refresh] Scheduled every ${safeInterval}ms`);
        return safeInterval;
    }

    scheduleStartupRefresh(delayMs = 100) {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null;
            this.refresh();
        }, delayMs);
    }

    clearScheduling() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.log.info('[Usage Cache Auto Refresh] Timer stopped');
        }
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        this.activeInterval = null;
    }

    async stop() {
        this.clearScheduling();
        if (this.isRunning) {
            await new Promise(resolve => this.idleWaiters.add(resolve));
        }
    }
}

export function startUsageCacheAutoRefreshService(config, providerPoolManager) {
    const service = new UsageCacheAutoRefreshService({ config, providerPoolManager });
    const normalized = normalizeUsageCacheAutoRefreshConfig(config);

    globalThis.reloadUsageCacheAutoRefreshTimer = (interval) => service.start(interval);
    globalThis.stopUsageCacheAutoRefreshTimer = () => service.stop();
    globalThis.runUsageCacheAutoRefreshNow = () => service.refresh();
    globalThis.getUsageCacheAutoRefreshStatus = () => ({
        isRunning: service.isRunning,
        interval: service.activeInterval
    });

    if (!normalized.enabled) {
        logger.info('[Usage Cache Auto Refresh] Disabled');
        return service;
    }

    const activeInterval = service.start(normalized.interval);
    globalThis._activeUsageCacheAutoRefreshInterval = activeInterval;
    if (normalized.startupRun) {
        service.scheduleStartupRefresh(100);
    }
    return service;
}
