export class ImageCapacityExceededError extends Error {
    constructor(message = 'Image capacity exceeded', details = null) {
        super(message);
        this.name = 'ImageCapacityExceededError';
        this.code = 'IMAGE_CAPACITY_EXCEEDED';
        this.status = 429;
        this.statusCode = 429;
        this.retryAfterSeconds = 5;
        if (details) this.details = details;
    }
}

export function resolveBigObjectBudget({ containerLimitBytes } = {}) {
    const limit = Number(containerLimitBytes);
    return Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit * 0.25)) : 2 * 1024 ** 3;
}

export function resolveImageQueueLimit(healthyCredentials = 0) {
    return Math.min(100, Math.max(20, Math.max(0, Number(healthyCredentials) || 0) * 2));
}

export class BigObjectCapacity {
    constructor({ budgetBytes = 2 * 1024 ** 3, queueLimit = 20, waitMs = 10_000, metrics = {} } = {}) {
        this.budgetBytes = Math.max(1, Number(budgetBytes) || 1);
        this.queueLimit = Math.max(0, Number(queueLimit) || 0);
        this.waitMs = Math.max(0, Number(waitMs) || 0);
        this.metrics = metrics;
        this.activeBytes = 0;
        this.queue = [];
    }

    _blockedReasons(bytes) {
        const rssLimit = Number(this.metrics.rssLimitBytes);
        const rss = Number(this.metrics.rssBytes);
        const reasons = [];
        if (this.activeBytes + bytes > this.budgetBytes) reasons.push('budget');
        if (rssLimit > 0 && rss >= rssLimit * 0.8) reasons.push('rss');
        if (Number(this.metrics.eventLoopP95Ms) > 200) reasons.push('event_loop');
        return reasons;
    }

    _blocked(bytes) {
        return this._blockedReasons(bytes).length > 0;
    }

    _capacityDetails(bytes) {
        return {
            blockedReasons: this._blockedReasons(bytes),
            activeBytes: this.activeBytes,
            budgetBytes: this.budgetBytes,
            estimatedBytes: bytes,
            rssBytes: Number(this.metrics.rssBytes) || 0,
            rssLimitBytes: Number(this.metrics.rssLimitBytes) || 0,
            eventLoopP95Ms: Number(this.metrics.eventLoopP95Ms) || 0,
            queued: this.queue.length
        };
    }

    _capacityError(bytes) {
        return new ImageCapacityExceededError('Image capacity exceeded', this._capacityDetails(bytes));
    }

    acquire({ bytes, kind = 'image' } = {}) {
        const estimatedBytes = Math.max(1, Number(bytes) || 1);
        if (!this._blocked(estimatedBytes)) {
            this.activeBytes += estimatedBytes;
            return Promise.resolve({ bytes: estimatedBytes, kind });
        }
        if (this.queue.length >= this.queueLimit) return Promise.reject(this._capacityError(estimatedBytes));
        return new Promise((resolve, reject) => {
            const item = { bytes: estimatedBytes, kind, resolve, reject };
            item.timer = setTimeout(() => {
                const index = this.queue.indexOf(item);
                if (index >= 0) this.queue.splice(index, 1);
                reject(this._capacityError(estimatedBytes));
            }, this.waitMs);
            item.timer.unref?.();
            this.queue.push(item);
        });
    }

    release(ticket) {
        if (!ticket) return false;
        this.activeBytes = Math.max(0, this.activeBytes - Math.max(1, Number(ticket.bytes) || 1));
        this._drain();
        return true;
    }

    _drain() {
        for (let index = 0; index < this.queue.length; index++) {
            const item = this.queue[index];
            if (this._blocked(item.bytes)) continue;
            this.queue.splice(index--, 1);
            clearTimeout(item.timer);
            this.activeBytes += item.bytes;
            item.resolve({ bytes: item.bytes, kind: item.kind });
        }
    }

    snapshot() {
        return { activeBytes: this.activeBytes, queued: this.queue.length, budgetBytes: this.budgetBytes };
    }
}
