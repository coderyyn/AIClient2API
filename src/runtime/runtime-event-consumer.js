export class RuntimeEventConsumer {
    constructor({ apply, ack, maxRemembered = 10000 } = {}) {
        this.apply = apply;
        this.ack = ack;
        this.maxRemembered = maxRemembered;
        this.applied = new Set();
    }

    async consume(event) {
        if (!event?.eventId) return this.apply(event);
        if (!this.applied.has(event.eventId)) {
            await this.apply(event);
            this.applied.add(event.eventId);
            if (this.applied.size > this.maxRemembered) {
                this.applied.delete(this.applied.values().next().value);
            }
        }
        await this.ack(event);
    }
}
