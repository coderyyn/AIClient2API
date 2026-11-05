import crypto from 'node:crypto';
const isTruthyConfigFlag = value => [true, 1, '1', 'true'].includes(value);
const isCodexProviderType = type => type === 'openai-codex-oauth' || type?.startsWith('openai-codex-oauth-');

function hashAffinityScope(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function resolveCodexAffinityKey(config, providerType, requestedModel = null, { force = false } = {}) {
    if (
        (!force && !isTruthyConfigFlag(config?.CODEX_POTLUCK_STICKY_PROVIDER_ENABLED)) ||
        !config?.potluckApiKey ||
        !isCodexProviderType(providerType)
    ) {
        return null;
    }

    const scope = config._codexCacheAffinityScope || {};
    if (scope.promptCacheKey) {
        return { key: `prompt-cache:${hashAffinityScope(scope.promptCacheKey)}`, source: 'prompt_cache_key' };
    }
    if (scope.threadId) {
        return { key: `thread:${hashAffinityScope(scope.threadId)}`, source: 'thread_id' };
    }
    if (scope.sessionId) {
        return { key: `session:${hashAffinityScope(scope.sessionId)}`, source: 'session_id' };
    }
    if (scope.installationId) {
        return { key: `installation:${hashAffinityScope(scope.installationId)}:model:${requestedModel || ''}`, source: 'installation_id' };
    }

    return { key: `potluck:${hashAffinityScope(config.potluckApiKey)}:model:${requestedModel || ''}`, source: 'potluck_key' };
}

