function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function extractUsage(value) {
    const usage = value?.usage || value?.message?.usage || value?.usageMetadata || value?.response?.usage || {};
    const prompt = number(value?.prompt_tokens ?? usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount);
    const completion = number(value?.completion_tokens ?? usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount);
    const total = number(value?.total_tokens ?? usage.total_tokens ?? usage.totalTokenCount) || prompt + completion;
    const cached = number(value?.cached_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens);
    const reasoning = number(value?.completion_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.thoughtsTokenCount);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, cached_tokens: cached, reasoning_tokens: reasoning };
}

function mergeUsage(current, next) {
    return {
        prompt_tokens: Math.max(current?.prompt_tokens || 0, next.prompt_tokens),
        completion_tokens: Math.max(current?.completion_tokens || 0, next.completion_tokens),
        total_tokens: Math.max(current?.total_tokens || 0, next.total_tokens),
        cached_tokens: Math.max(current?.cached_tokens || 0, next.cached_tokens),
        reasoning_tokens: Math.max(current?.reasoning_tokens || 0, next.reasoning_tokens)
    };
}

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
            current.usage = mergeUsage(current.usage, mergeUsage(extractUsage(context.nativeChunk), extractUsage(context.chunkToSend)));
            current.hasImage ||= containsImage(context.nativeChunk) || containsImage(context.chunkToSend);
            this.pending.set(requestId, current);
            return;
        }

        if (hookName === 'onUnaryResponse') {
            if (!requestId) return;
            const usage = mergeUsage(extractUsage(context.nativeResponse), extractUsage(context.clientResponse));
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
                    nativeResponse: { usage: pending.usage },
                    clientResponse: pending.hasImage ? { data: [{ url: 'image://result' }] } : { usage: pending.usage }
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
