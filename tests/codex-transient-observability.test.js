import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

    test('persists allowlisted retry diagnostics with the full provider UUID', () => {
        const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retry-audit-'));
        const metrics = new CodexTransientRetryObservability({
            logger: { warn: jest.fn() },
            auditDirectory,
            auditMaxFileSize: 1024,
            auditMaxFiles: 2,
            auditRetentionDays: 1
        });

        try {
            metrics.record({
                kind: 'capacity',
                requestId: 'req-429',
                model: 'gpt-5.4-mini',
                providerUuid: 'provider-uuid-123',
                attempt: 2,
                maxRetries: 5,
                httpStatus: 429,
                retryAfterMs: 30000,
                eligibleCandidateCount: 3,
                outcome: 'switch',
                accessToken: 'must-not-be-written',
                prompt: 'must-not-be-written'
            });

            const files = fs.readdirSync(auditDirectory);
            expect(files).toHaveLength(1);

            const record = JSON.parse(fs.readFileSync(path.join(auditDirectory, files[0]), 'utf8'));
            expect(record).toMatchObject({
                requestId: 'req-429',
                model: 'gpt-5.4-mini',
                providerUuid: 'provider-uuid-123',
                attempt: 2,
                maxRetries: 5,
                httpStatus: 429,
                retryAfterMs: 30000,
                switched: true,
                eligibleCandidateCount: 3,
                outcome: 'switch',
                kind: 'capacity'
            });
            expect(JSON.stringify(record)).not.toContain('must-not-be-written');
        } finally {
            fs.rmSync(auditDirectory, { recursive: true, force: true });
        }
    });

    test('does not persist events when the retry audit is disabled', () => {
        const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retry-audit-disabled-'));
        const metrics = new CodexTransientRetryObservability({ logger: { warn: jest.fn() }, auditDirectory });

        try {
            metrics.record({
                kind: 'capacity',
                providerUuid: 'provider-uuid-123',
                auditEnabled: false
            });

            expect(fs.readdirSync(auditDirectory)).toHaveLength(0);
        } finally {
            fs.rmSync(auditDirectory, { recursive: true, force: true });
        }
    });

    test('keeps retry audit files within the configured count cap', () => {
        const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retry-audit-cap-'));
        let now = 1_000;
        const metrics = new CodexTransientRetryObservability({
            logger: { warn: jest.fn() },
            now: () => now,
            auditDirectory,
            auditMaxFileSize: 1,
            auditMaxFiles: 2,
            auditRetentionDays: 1
        });

        try {
            for (let attempt = 1; attempt <= 4; attempt += 1) {
                metrics.record({ kind: 'capacity', attempt, providerUuid: 'provider-uuid-123' });
                now += 1;
            }

            expect(fs.readdirSync(auditDirectory)).toHaveLength(2);
        } finally {
            fs.rmSync(auditDirectory, { recursive: true, force: true });
        }
    });
});
