function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function emptyUsage() {
    return {
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
    };
}

export function normalizeUsageCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (Array.isArray(candidate)) return extractUsage(...candidate);

    const usage = candidate.usage
        || candidate.message?.usage
        || candidate.usageMetadata
        || candidate.response?.usage
        || candidate;
    const promptTokens = toNumber(
        candidate.promptTokens ?? candidate.prompt_tokens ?? candidate.input_tokens ??
        usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ??
        usage.promptTokenCount ?? usage.inputTokenCount
    );
    const completionTokens = toNumber(
        candidate.completionTokens ?? candidate.completion_tokens ?? candidate.output_tokens ??
        usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ??
        usage.candidatesTokenCount ?? usage.outputTokenCount
    );
    const cachedTokens = toNumber(
        candidate.cachedTokens ?? candidate.cached_tokens ??
        candidate.prompt_tokens_details?.cached_tokens ?? candidate.input_tokens_details?.cached_tokens ??
        usage.cachedTokens ?? usage.cached_tokens ??
        usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ??
        usage.cache_read_input_tokens ?? usage.cachedContentTokenCount
    );
    const reasoningTokens = toNumber(
        candidate.reasoningTokens ?? candidate.reasoning_tokens ??
        candidate.completion_tokens_details?.reasoning_tokens ?? candidate.output_tokens_details?.reasoning_tokens ??
        usage.reasoningTokens ?? usage.reasoning_tokens ??
        usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ??
        usage.thoughtsTokenCount
    );
    const totalTokens = toNumber(
        candidate.totalTokens ?? candidate.total_tokens ??
        usage.totalTokens ?? usage.total_tokens ?? usage.totalTokenCount
    ) || promptTokens + completionTokens;

    return { promptTokens, cachedTokens, completionTokens, reasoningTokens, totalTokens };
}

export function mergeUsage(base = emptyUsage(), next = null) {
    if (!next) return base;
    const normalized = normalizeUsageCandidate(next) || emptyUsage();
    return {
        promptTokens: Math.max(toNumber(base.promptTokens), normalized.promptTokens),
        cachedTokens: Math.max(toNumber(base.cachedTokens), normalized.cachedTokens),
        completionTokens: Math.max(toNumber(base.completionTokens), normalized.completionTokens),
        reasoningTokens: Math.max(toNumber(base.reasoningTokens), normalized.reasoningTokens),
        totalTokens: Math.max(toNumber(base.totalTokens), normalized.totalTokens)
    };
}

export function extractUsage(...candidates) {
    return candidates.reduce((usage, candidate) => mergeUsage(usage, candidate), emptyUsage());
}

export function toWireUsage(usage = {}) {
    const normalized = normalizeUsageCandidate(usage) || emptyUsage();
    return {
        prompt_tokens: normalized.promptTokens,
        completion_tokens: normalized.completionTokens,
        total_tokens: normalized.totalTokens,
        cached_tokens: normalized.cachedTokens,
        reasoning_tokens: normalized.reasoningTokens
    };
}
