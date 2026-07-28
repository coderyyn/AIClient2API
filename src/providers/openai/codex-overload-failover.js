const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function resolveCodexOverloadFailoverKey(scope) {
    if (!scope || typeof scope !== 'object') return null;
    if (scope.threadId) return `thread:${scope.threadId}`;
    if (scope.sessionId) return `session:${scope.sessionId}`;
    if (scope.installationId) return `installation:${scope.installationId}`;
    if (scope.promptCacheKey) return `prompt-cache:${scope.promptCacheKey}`;
    return null;
}

export class CodexOverloadFailoverStore {
    constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
        this.ttlMs = ttlMs;
        this.entries = new Map();
    }

    _get(key, now) {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now) {
            this.entries.delete(key);
            return null;
        }
        return entry;
    }

    _set(key, entry, now) {
        this.entries.set(key, {
            ...entry,
            expiresAt: now + this.ttlMs
        });
    }

    recordFailure(key, providerUuid, now = Date.now()) {
        if (!key || !providerUuid) return;
        this._set(key, {
            failedProviderUuid: providerUuid,
            pinnedProviderUuid: null
        }, now);
    }

    getPendingExclusion(key, now = Date.now()) {
        return this._get(key, now)?.failedProviderUuid || null;
    }

    consumePendingExclusion(key, now = Date.now()) {
        const entry = this._get(key, now);
        if (!entry?.failedProviderUuid) return null;
        this.entries.set(key, {
            ...entry,
            failedProviderUuid: null
        });
        return entry.failedProviderUuid;
    }

    pinAlternative(key, providerUuid, now = Date.now()) {
        if (!key || !providerUuid) return;
        const current = this._get(key, now);
        this._set(key, {
            failedProviderUuid: null,
            pinnedProviderUuid: providerUuid
        }, now);
    }

    getPinnedProvider(key, now = Date.now()) {
        return this._get(key, now)?.pinnedProviderUuid || null;
    }

    clear(key) {
        if (!key) return false;
        return this.entries.delete(key);
    }

    resolveProviderOrder(providerUuids, key, now = Date.now()) {
        const providers = Array.isArray(providerUuids) ? [...providerUuids] : [];
        const entry = this._get(key, now);
        const preferred = entry?.pinnedProviderUuid;
        const excluded = entry?.failedProviderUuid;

        if (preferred && providers.includes(preferred)) {
            return [preferred, ...providers.filter(uuid => uuid !== preferred)];
        }
        if (excluded && providers.length > 1) {
            return [...providers.filter(uuid => uuid !== excluded), excluded];
        }
        return providers;
    }
}

export const codexOverloadFailoverStore = new CodexOverloadFailoverStore();
