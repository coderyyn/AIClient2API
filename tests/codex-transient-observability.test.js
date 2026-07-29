import { describe, expect, jest, test } from '@jest/globals';
import { CodexTransientRetryObservability } from '../src/providers/openai/codex-transient-observability.js';

describe('Codex transient retry observability', () => {
    test('logs sanitized retry events and emits five-minute aggregate counters', () => {
        const logger = { warn: jest.fn() };
        let now = 1_000;
        const metrics = new CodexTransientRetryObservability({ logger, now: () => now, windowMs: 300_000 });

        metrics.record({
            kind: 'capacity',
            model: 'gpt-5.4-mini',
            providerUuid: 'provider-secret-uuid',
            attempt: 1,
            maxRetries: 5,
            eligibleCandidateCount: 2,
            outcome: 'switch',
            reused: false
        });

        now += 300_000;
        metrics.record({
            kind: 'overload',
            model: 'gpt-5.4-mini',
            providerUuid: 'provider-secret-uuid',
            attempt: 2,
            maxRetries: 5,
            eligibleCandidateCount: 0,
            outcome: 'exhausted',
            reused: true,
            noEligible: true,
            skipReasons: { codex53_quota_exceeded: 1, cooldown: 2, concurrency_limit: 1 }
        });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('kind=capacity'));
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('provider-secret-uuid'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Codex Retry Summary'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('noEligible=1'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('quotaSkipped=1'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('healthCooldownSkipped=2'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('concurrencyLimitSkipped=1'));
    });
});
