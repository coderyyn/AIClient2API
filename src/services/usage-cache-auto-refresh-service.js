import logger from '../utils/logger.js';
import { getAllProvidersUsage } from '../ui-modules/usage-api.js';
import { writeUsageCache } from '../ui-modules/usage-cache.js';

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
    constructor({ config, providerPoolManager, log = logger } = {}) {
        this.config = config || {};
        this.providerPoolManager = providerPoolManager;
        this.log = log;
        this.timer = null;
        this.isRunning = false;
        this.activeInterval = null;
    }

    async refresh() {
        if (this.isRunning) {
            this.log.debug('[Usage Cache Auto Refresh] Skipping - previous run still in progress');
            return { skipped: true };
        }

        this.isRunning = true;
        try {
            this.log.info('[Usage Cache Auto Refresh] Fetching fresh usage data');
            const usageData = await getAllProvidersUsage(this.config, this.providerPoolManager);
            await writeUsageCache(usageData);
            this.log.info('[Usage Cache Auto Refresh] Usage cache refreshed');
            return { skipped: false, usageData };
        } catch (error) {
            this.log.error('[Usage Cache Auto Refresh] Refresh failed:', error);
            return { skipped: false, error };
        } finally {
            this.isRunning = false;
        }
    }

    start(interval) {
        this.stop();
        const safeInterval = normalizeInterval(interval);
        this.activeInterval = safeInterval;
        this.timer = setInterval(() => {
            this.refresh();
        }, safeInterval);
        this.log.info(`[Usage Cache Auto Refresh] Scheduled every ${safeInterval}ms`);
        return safeInterval;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.log.info('[Usage Cache Auto Refresh] Timer stopped');
        }
        this.activeInterval = null;
    }
}

export function startUsageCacheAutoRefreshService(config, providerPoolManager) {
    const service = new UsageCacheAutoRefreshService({ config, providerPoolManager });
    const normalized = normalizeUsageCacheAutoRefreshConfig(config);

    globalThis.reloadUsageCacheAutoRefreshTimer = (interval) => service.start(interval);
    globalThis.stopUsageCacheAutoRefreshTimer = () => service.stop();
    globalThis.runUsageCacheAutoRefreshNow = () => service.refresh();

    if (!normalized.enabled) {
        logger.info('[Usage Cache Auto Refresh] Disabled');
        return service;
    }

    if (normalized.startupRun) {
        setTimeout(() => {
            service.refresh();
        }, 100);
    }

    const activeInterval = service.start(normalized.interval);
    globalThis._activeUsageCacheAutoRefreshInterval = activeInterval;
    return service;
}
