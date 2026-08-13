import crypto from 'crypto';
import logger from '../../utils/logger.js';

function shapeOf(value, seen = new WeakSet()) {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
        return `array:${value.length}[${value.map(item => shapeOf(item, seen)).join(',')}]`;
    }
    if (typeof value !== 'object') return typeof value;
    if (seen.has(value)) return 'circular';
    seen.add(value);
    const shape = Object.keys(value)
        .sort()
        .map(key => `${key}:${shapeOf(value[key], seen)}`)
        .join(',');
    seen.delete(value);
    return `object{${shape}}`;
}

function hashShape(value) {
    return `sha256:${crypto.createHash('sha256').update(shapeOf(value)).digest('hex').slice(0, 32)}`;
}

function providerTypeOf(providerType) {
    const value = String(providerType || 'unknown').trim();
    return value || 'unknown';
}

function isCodexOAuthProviderType(providerType) {
    const normalized = providerTypeOf(providerType);
    return normalized === 'openai-codex-oauth' || normalized.startsWith('openai-codex-oauth-');
}

function createSnapshot() {
    return {
        present: 0,
        upstream400: 0,
        byProviderType: {}
    };
}

export class CodexPromptCacheObservability {
    constructor({ logger: eventLogger = logger } = {}) {
        this.logger = eventLogger;
        this.metrics = createSnapshot();
    }

    _bucket(providerType) {
        const normalized = providerTypeOf(providerType);
        this.metrics.byProviderType[normalized] ||= { present: 0, upstream400: 0 };
        return this.metrics.byProviderType[normalized];
    }

    _record(kind, event = {}) {
        const hasOptions = Object.prototype.hasOwnProperty.call(event, 'promptCacheOptions') &&
            event.promptCacheOptions !== undefined;
        if (!hasOptions) return null;

        const providerType = providerTypeOf(event.providerType);
        if (!isCodexOAuthProviderType(providerType)) return null;
        const bucket = this._bucket(providerType);
        const shapeHash = hashShape(event.promptCacheOptions);
        if (kind === 'presence') {
            this.metrics.present += 1;
            bucket.present += 1;
        } else if (kind === 'upstream400') {
            this.metrics.upstream400 += 1;
            bucket.upstream400 += 1;
        }

        const summary = {
            kind,
            providerType,
            shapeHash,
            httpStatus: event.httpStatus ?? null,
            errorClass: event.errorClass || null,
            totalPresent: this.metrics.present,
            totalUpstream400: this.metrics.upstream400,
            providerPresent: bucket.present,
            providerUpstream400: bucket.upstream400
        };
        this.logger?.info?.(`[Codex Prompt Cache] ${JSON.stringify(summary)}`);
        return summary;
    }

    recordPresence(event = {}) {
        return this._record('presence', event);
    }

    recordUpstreamError(event = {}) {
        if (Number(event.httpStatus) !== 400) return null;
        return this._record('upstream400', event);
    }

    snapshot() {
        return structuredClone(this.metrics);
    }
}

export const codexPromptCacheObservability = new CodexPromptCacheObservability();
