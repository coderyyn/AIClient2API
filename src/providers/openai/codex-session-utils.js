function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return null;
}

export function resolveCodexSessionId(requestBody = {}) {
    const metadata = requestBody.metadata || {};
    const clientMetadata = requestBody.client_metadata || {};

    return firstNonEmptyString(
        metadata.session_id,
        metadata.conversation_id,
        metadata.user_id,
        clientMetadata.session_id,
        clientMetadata.conversation_id,
        clientMetadata.thread_id,
        clientMetadata.user_id
    ) || 'default';
}

export function getProvidedPromptCacheKey(requestBody = {}) {
    return firstNonEmptyString(requestBody.prompt_cache_key);
}
