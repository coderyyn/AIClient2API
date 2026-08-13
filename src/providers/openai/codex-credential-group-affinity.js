const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class CodexCredentialGroupAffinityStore {
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

    pinGroup(key, groupId, now = Date.now()) {
        if (!key || !groupId) return;
        this.entries.set(key, {
            groupId: String(groupId),
            expiresAt: now + this.ttlMs
        });
    }

    getPinnedGroup(key, now = Date.now()) {
        return this._get(key, now)?.groupId || null;
    }

    clear(key) {
        if (!key) return false;
        return this.entries.delete(key);
    }

    clearAll() {
        this.entries.clear();
    }
}

export const codexCredentialGroupAffinityStore = new CodexCredentialGroupAffinityStore();
