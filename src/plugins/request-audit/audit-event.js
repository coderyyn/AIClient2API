import crypto from 'crypto';

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function hashSecret(value, length = 16) {
    if (!value) return null;
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

export function maskPotluckKey(key) {
    if (!key) {
        return { present: false, hash: null, prefix: null };
    }
    const text = String(key);
    return {
        present: true,
        hash: hashSecret(text),
        prefix: `${text.slice(0, 11)}...`
    };
}

export function sanitizeProviderName(name) {
    if (!name) return null;
    const text = String(name);
    const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    if (email) {
        return `redacted-email:${crypto.createHash('sha256').update(email[0].toLowerCase()).digest('hex').slice(0, 8)}`;
    }
    if (text.length <= 24 && !/[A-Za-z0-9._~+/=-]{32,}/.test(text)) {
        return text;
    }
    return `redacted-name:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

export function extractAccountEmail(...candidates) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        const email = String(candidate).match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
        if (email) return email[0].toLowerCase();
    }
    return null;
}

export function normalizeUsage(usage = {}) {
    const promptTokens = toNumber(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens);
    const cachedTokens = toNumber(
        usage.cachedTokens ??
        usage.cached_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens
    );
    const reasoningTokens = toNumber(
        usage.reasoningTokens ??
        usage.reasoning_tokens ??
        usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens
    );
    const completionTokens = toNumber(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens);
    const totalTokens = toNumber(usage.totalTokens ?? usage.total_tokens) || promptTokens + completionTokens;
    return {
        promptTokens,
        cachedTokens,
        completionTokens,
        reasoningTokens,
        totalTokens,
        cacheHitRatio: promptTokens > 0 ? cachedTokens / promptTokens : 0
    };
}

function getBeijingParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false
    }).formatToParts(date);
    const value = type => parts.find(part => part.type === type)?.value;
    return {
        date: `${value('year')}-${value('month')}-${value('day')}`,
        hour: value('hour') || '00'
    };
}

export function buildRequestAuditEvent(context = {}) {
    const timestamp = context.timestamp || new Date().toISOString();
    const date = new Date(timestamp);
    const beijing = getBeijingParts(date);
    const usage = normalizeUsage(context.usage);
    const actualModel = context.model || context.processedRequestBody?.model || context.originalRequestBody?.model || 'unknown';
    const requestedModel = context.originalRequestBody?.model || actualModel;

    return {
        schemaVersion: 1,
        timestamp,
        beijingDate: beijing.date,
        beijingHour: beijing.hour,
        requestId: context.requestId || context._monitorRequestId || null,
        request: {
            method: context.method || 'POST',
            path: context.path || context.requestPath || null,
            fromProvider: context.fromProvider || null,
            toProvider: context.toProvider || context.provider || null,
            model: actualModel,
            requestedModel,
            actualModel,
            stream: Boolean(context.isStream)
        },
        potluckKey: {
            ...maskPotluckKey(context.potluckApiKey),
            name: context.potluckKeyData?.name || null
        },
        account: {
            providerUuid: context.providerUuid || null,
            accountEmail: extractAccountEmail(context.accountEmail, context.accountIdentity, context.providerName),
            providerNameHash: hashSecret(context.providerName),
            providerNameDisplay: sanitizeProviderName(context.providerName)
        },
        status: {
            outcome: context.outcome || 'success',
            httpStatus: context.httpStatus || 200,
            errorClass: context.errorClass || null,
            retryCount: toNumber(context.retryCount),
            cooldownApplied: Boolean(context.cooldownApplied)
        },
        usage
    };
}
