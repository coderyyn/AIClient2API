import { extractUsage, mergeUsage, toWireUsage } from '../utils/usage-normalizer.js';

function containsImage(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (typeof value.b64_json === 'string' && value.b64_json) return true;
    if (typeof value.url === 'string' && value.url.startsWith('data:image/')) return true;
    if (value.type === 'image_generation_call' && typeof value.result === 'string') return true;
    return Object.values(value).some(item => Array.isArray(item)
        ? item.some(child => containsImage(child, seen))
        : containsImage(item, seen));
}

function compactMetadata(context = {}) {
    return {
        requestId: context.requestId || context._monitorRequestId || null,
        _monitorRequestId: context._monitorRequestId || context.requestId || null,
        _requestAuditLifecycle: context._requestAuditLifecycle === true,
        model: context.model || null,
        fromProvider: context.fromProvider || null,
        toProvider: context.toProvider || null,
        providerUuid: context.providerUuid || null,
        providerName: context.providerName || null,
        accountIdentity: context.accountIdentity || null,
        accountEmail: context.accountEmail || null,
        potluckApiKey: context.potluckApiKey || null,
        _codexRouting: context._codexRouting ? {
            affinitySource: context._codexRouting.affinitySource || null,
            hotShardApplied: context._codexRouting.hotShardApplied === true
        } : undefined,
        isStream: context.isStream === true,
        method: context.method || null,
        path: context.path || null,
        normalizedPath: context.normalizedPath || null,
        response: context.response ? {
            statusCode: context.response.statusCode,
            durationMs: context.response.durationMs,
            errorCode: context.response.errorCode
        } : undefined,
        errorClass: context.errorClass || null
    };
}

export class RuntimeHookBridge {
    constructor({ send, maxPending = 1000 }) {
        this.send = send;
        this.pending = new Map();
        this.maxPending = Math.max(1, Number(maxPending) || 1);
        this.outbound = new Map();
        this.dropped = 0;
    }

    _send(message) {
        if (this.outbound.size >= this.maxPending) {
            this.dropped += 1;
            return false;
        }
        const eventId = message.eventId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const outbound = { ...message, eventId };
        this.outbound.set(eventId, outbound);
        this.send(outbound);
        return true;
    }

    ack(eventId) {
        return this.outbound.delete(eventId);
    }

    retryUnacked() {
        for (const message of this.outbound.values()) this.send(message);
    }

    snapshot() {
        return { pending: this.outbound.size, dropped: this.dropped, maxPending: this.maxPending };
    }

    async handle(hookName, context = {}) {
        const requestId = context.requestId || context._monitorRequestId;
        if (hookName === 'onStreamChunk') {
            if (!requestId) return;
            const current = this.pending.get(requestId) || { metadata: compactMetadata(context), usage: {}, hasImage: false };
            current.usage = mergeUsage(current.usage, extractUsage(context.nativeChunk, context.chunkToSend));
            current.hasImage ||= containsImage(context.nativeChunk) || containsImage(context.chunkToSend);
            this.pending.set(requestId, current);
            return;
        }

        if (hookName === 'onUnaryResponse') {
            if (!requestId) return;
            const usage = extractUsage(context.nativeResponse, context.clientResponse);
            this.pending.set(requestId, { metadata: compactMetadata(context), usage, hasImage: containsImage(context.nativeResponse) || containsImage(context.clientResponse) });
            return;
        }

        if (hookName === 'onContentGenerated') {
            const pending = this.pending.get(requestId) || { metadata: {}, usage: {}, hasImage: false };
            this.pending.delete(requestId);
            const metadata = { ...pending.metadata, ...compactMetadata(context) };
            this._send({
                type: 'runtime_hook',
                hookName: 'onUnaryResponse',
                args: [{
                    ...metadata,
                    nativeResponse: { usage: toWireUsage(pending.usage) },
                    clientResponse: pending.hasImage ? { data: [{ url: 'image://result' }] } : { usage: toWireUsage(pending.usage) }
                }]
            });
            this._send({ type: 'runtime_hook', hookName, args: [metadata] });
            return;
        }

        if (hookName === 'onRequestCompleted') {
            this._send({ type: 'runtime_hook', hookName, args: [compactMetadata(context)] });
        }
    }
}
