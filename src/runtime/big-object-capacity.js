export class ImageCapacityExceededError extends Error {
    constructor(message = 'Image capacity exceeded') {
        super(message);
        this.name = 'ImageCapacityExceededError';
        this.code = 'IMAGE_CAPACITY_EXCEEDED';
        this.status = 429;
        this.statusCode = 429;
        this.retryAfterSeconds = 5;
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

    _blocked(bytes) {
        const rssLimit = Number(this.metrics.rssLimitBytes);
        const rss = Number(this.metrics.rssBytes);
        return this.activeBytes + bytes > this.budgetBytes
            || (rssLimit > 0 && rss >= rssLimit * 0.8)
            || Number(this.metrics.eventLoopP95Ms) > 200
            || Number(this.metrics.backpressureMs) > 0;
    }

    acquire({ bytes, kind = 'image' } = {}) {
        const estimatedBytes = Math.max(1, Number(bytes) || 1);
        if (!this._blocked(estimatedBytes)) {
            this.activeBytes += estimatedBytes;
            return Promise.resolve({ bytes: estimatedBytes, kind });
        }
        if (this.queue.length >= this.queueLimit) return Promise.reject(new ImageCapacityExceededError());
        return new Promise((resolve, reject) => {
            const item = { bytes: estimatedBytes, kind, resolve, reject };
            item.timer = setTimeout(() => {
                const index = this.queue.indexOf(item);
                if (index >= 0) this.queue.splice(index, 1);
                reject(new ImageCapacityExceededError());
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
