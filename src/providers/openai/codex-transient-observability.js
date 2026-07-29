import crypto from 'crypto';
import logger from '../../utils/logger.js';

function anonymizeProviderUuid(uuid) {
    if (!uuid) return 'none';
    return crypto.createHash('sha256').update(String(uuid)).digest('hex').slice(0, 12);
}

function createCounters() {
    return {
        events: 0,
        capacity: 0,
        overload: 0,
        switched: 0,
        reused: 0,
        recovered: 0,
        exhausted: 0,
        noEligible: 0,
        quotaSkipped: 0,
        healthCooldownSkipped: 0,
        concurrencyLimitSkipped: 0
    };
}

export class CodexTransientRetryObservability {
    constructor({ logger: eventLogger = logger, now = () => Date.now(), windowMs = 5 * 60 * 1000 } = {}) {
        this.logger = eventLogger;
        this.now = now;
        this.windowMs = windowMs;
        this.windowStartedAt = now();
        this.counters = createCounters();
    }

    record(event = {}) {
        const now = this.now();
        const counters = this.counters;
        counters.events += 1;
        if (event.kind === 'capacity') counters.capacity += 1;
        if (event.kind === 'overload') counters.overload += 1;
        if (event.outcome === 'switch') counters.switched += 1;
        if (event.outcome === 'recovered') counters.recovered += 1;
        if (event.outcome === 'exhausted') counters.exhausted += 1;
        if (event.reused === true) counters.reused += 1;
        if (event.noEligible === true) counters.noEligible += 1;
        counters.healthCooldownSkipped += Number(event.healthCooldownSkipped) || 0;
        counters.concurrencyLimitSkipped += Number(event.concurrencyLimitSkipped) || 0;

        for (const [reason, count] of Object.entries(event.skipReasons || {})) {
            const safeCount = Number(count) || 0;
            if (/quota|plan_/.test(reason)) counters.quotaSkipped += safeCount;
            else if (/cooldown|health/.test(reason)) counters.healthCooldownSkipped += safeCount;
            else if (/concurr|queue|limit/.test(reason)) counters.concurrencyLimitSkipped += safeCount;
        }

        this.logger.warn(
            `[Codex Retry] origin=upstream_codex kind=${event.kind || 'unknown'} model=${event.model || 'unknown'} ` +
            `provider=${anonymizeProviderUuid(event.providerUuid)} attempt=${event.attempt ?? 0}/${event.maxRetries ?? 0} ` +
            `eligible=${event.eligibleCandidateCount ?? 'unknown'} reused=${event.reused === true} outcome=${event.outcome || 'unknown'}`
        );

        if (now - this.windowStartedAt >= this.windowMs) {
            this.logger.warn(
                `[Codex Retry Summary] windowMs=${now - this.windowStartedAt} events=${counters.events} capacity=${counters.capacity} overload=${counters.overload} ` +
                `switched=${counters.switched} reused=${counters.reused} recovered=${counters.recovered} exhausted=${counters.exhausted} ` +
                `noEligible=${counters.noEligible} quotaSkipped=${counters.quotaSkipped} healthCooldownSkipped=${counters.healthCooldownSkipped} ` +
                `concurrencyLimitSkipped=${counters.concurrencyLimitSkipped}`
            );
            this.windowStartedAt = now;
            this.counters = createCounters();
        }
    }
}

export const codexTransientRetryObservability = new CodexTransientRetryObservability();
