const MUTABLE_STATE_FIELDS = [
    'isHealthy', 'isDisabled', 'needsRefresh', 'errorCount', 'usageCount',
    'lastUsed', 'lastErrorTime', 'lastErrorMessage', 'lastHealthCheckTime',
    'lastHealthCheckModel', 'scheduledRecoveryTime', 'refreshCount',
    'antigravityQuotaHealth', 'codexQuotaHealth', 'lastKnownAntigravityPlan',
    'lastKnownCodexPlan'
];

export function createProviderStateEvent(providerType, config = {}) {
    const state = {};
    for (const field of MUTABLE_STATE_FIELDS) {
        if (config[field] !== undefined) state[field] = structuredClone(config[field]);
    }
    return {
        type: 'provider_state',
        providerType: String(providerType || ''),
        uuid: String(config.uuid || ''),
        state,
        occurredAt: new Date().toISOString()
    };
}

export function applyProviderStateEvent(providerPools, event) {
    const providers = providerPools?.[event?.providerType];
    if (!Array.isArray(providers)) return false;
    const target = providers.find(provider => provider.uuid === event.uuid);
    if (!target) return false;
    for (const field of MUTABLE_STATE_FIELDS) {
        if (event.state?.[field] !== undefined) target[field] = structuredClone(event.state[field]);
    }
    return true;
}
