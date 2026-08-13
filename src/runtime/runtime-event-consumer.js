export class RuntimeEventConsumer {
    constructor({ apply, ack, maxRemembered = 10000 } = {}) {
        this.apply = apply;
        this.ack = ack;
        this.maxRemembered = maxRemembered;
        this.applied = new Set();
        this.pending = new Map();
        this.tail = Promise.resolve();
    }

    async consume(event) {
        if (!event?.eventId) return this._enqueue(() => this.apply(event));
        if (this.applied.has(event.eventId)) {
            await this.ack(event);
            return;
        }

        let operation = this.pending.get(event.eventId);
        if (!operation) {
            operation = this._enqueue(async () => {
                await this.apply(event);
                this.applied.add(event.eventId);
                if (this.applied.size > this.maxRemembered) {
                    this.applied.delete(this.applied.values().next().value);
                }
            });
            this.pending.set(event.eventId, operation);
        }

        try {
            await operation;
        } finally {
            if (this.pending.get(event.eventId) === operation) this.pending.delete(event.eventId);
        }
        await this.ack(event);
    }

    _enqueue(operation) {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => {});
        return result;
    }
}
