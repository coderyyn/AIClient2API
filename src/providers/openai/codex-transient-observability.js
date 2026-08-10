import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

const DEFAULT_AUDIT_DIRECTORY = 'configs/retry-audit';
const DEFAULT_AUDIT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const DEFAULT_AUDIT_MAX_FILES = 7;
const DEFAULT_AUDIT_RETENTION_DAYS = 7;

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
    constructor({
        logger: eventLogger = logger,
        now = () => Date.now(),
        windowMs = 5 * 60 * 1000,
        auditDirectory = DEFAULT_AUDIT_DIRECTORY,
        auditMaxFileSize = DEFAULT_AUDIT_MAX_FILE_SIZE,
        auditMaxFiles = DEFAULT_AUDIT_MAX_FILES,
        auditRetentionDays = DEFAULT_AUDIT_RETENTION_DAYS
    } = {}) {
        this.logger = eventLogger;
        this.now = now;
        this.windowMs = windowMs;
        this.auditDirectory = auditDirectory;
        this.auditMaxFileSize = auditMaxFileSize;
        this.auditMaxFiles = auditMaxFiles;
        this.auditRetentionDays = auditRetentionDays;
        this.windowStartedAt = now();
        this.counters = createCounters();
    }

    writeAuditEvent(event) {
        if (event.auditEnabled === false) return;

        try {
            const now = new Date(this.now());
            const date = now.toISOString().slice(0, 10);
            const auditDirectory = event.auditDirectory || this.auditDirectory;
            const auditMaxFileSize = Math.max(1, Number(event.auditMaxFileSize) || this.auditMaxFileSize);
            const auditMaxFiles = Math.max(1, Number(event.auditMaxFiles) || this.auditMaxFiles);
            const auditRetentionDays = Math.max(1, Number(event.auditRetentionDays) || this.auditRetentionDays);
            const record = {
                timestamp: now.toISOString(),
                requestId: event.requestId || null,
                kind: event.kind || 'unknown',
                model: event.model || 'unknown',
                providerUuid: event.providerUuid || null,
                attempt: event.attempt ?? 0,
                maxRetries: event.maxRetries ?? 0,
                httpStatus: event.httpStatus ?? null,
                retryAfterMs: event.retryAfterMs ?? null,
                switched: event.outcome === 'switch',
                eligibleCandidateCount: event.eligibleCandidateCount ?? null,
                outcome: event.outcome || 'unknown'
            };
            const payload = `${JSON.stringify(record)}\n`;
            const activeFile = path.join(auditDirectory, `codex-retry-${date}.jsonl`);

            fs.mkdirSync(auditDirectory, { recursive: true });
            if (fs.existsSync(activeFile) && fs.statSync(activeFile).size + Buffer.byteLength(payload) > auditMaxFileSize) {
                fs.renameSync(activeFile, path.join(auditDirectory, `codex-retry-${date}-${this.now()}.jsonl`));
            }
            fs.appendFileSync(activeFile, payload, 'utf8');
            this.cleanupAuditFiles({ auditDirectory, auditMaxFiles, auditRetentionDays });
        } catch (error) {
            this.logger.warn(`[Codex Retry Audit] Failed to persist event: ${error.message}`);
        }
    }

    cleanupAuditFiles({ auditDirectory = this.auditDirectory, auditMaxFiles = this.auditMaxFiles, auditRetentionDays = this.auditRetentionDays } = {}) {
        const now = this.now();
        const retentionMs = Math.max(1, Number(auditRetentionDays) || DEFAULT_AUDIT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
        const maxFiles = Math.max(1, Number(auditMaxFiles) || DEFAULT_AUDIT_MAX_FILES);
        const files = fs.readdirSync(auditDirectory)
            .filter(name => /^codex-retry-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name))
            .map(name => ({ name, path: path.join(auditDirectory, name), stats: fs.statSync(path.join(auditDirectory, name)) }))
            .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

        for (const file of files) {
            if (file.stats.mtimeMs < now - retentionMs) {
                fs.unlinkSync(file.path);
            }
        }

        const remaining = files.filter(file => fs.existsSync(file.path));
        for (const file of remaining.slice(maxFiles)) {
            fs.unlinkSync(file.path);
        }
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
        this.writeAuditEvent(event);

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
