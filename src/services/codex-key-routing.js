const DEFAULT_UNKNOWN_CAPACITY = 0.5;
const MAX_RESTRICTED_CREDENTIALS = 5;
const MIN_RESTRICTED_CREDENTIALS = 2;

function toPositiveNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeRemainingRatio(value) {
    if (value === undefined || value === null || value === '') return null;
    let ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    if (ratio > 1 && ratio <= 100) ratio /= 100;
    return Math.max(0, Math.min(1, ratio));
}

function getCredentialUuid(credential) {
    return credential?.uuid || credential?.providerUuid || credential?.config?.uuid || null;
}

function getCredentialProviderType(credential) {
    return credential?.providerType || credential?.provider || credential?.type || 'openai-codex-oauth';
}

function isCredentialHealthy(credential) {
    return credential?.isHealthy !== false
        && credential?.isDisabled !== true
        && credential?.disabled !== true
        && credential?.needsRefresh !== true
        && credential?.available !== false;
}

export function calculateCredentialCapacity(credential = {}) {
    const explicitWeight = toPositiveNumber(credential.providerWeight ?? credential.weight);
    const providerWeight = explicitWeight ?? 1;
    const fiveHourRemainingRatio = normalizeRemainingRatio(
        credential.fiveHourRemainingRatio
        ?? credential.shortWindowRemainingRatio
        ?? credential.quota?.fiveHourRemainingRatio
        ?? credential.quota?.shortRemainingRatio
    );
    const weeklyRemainingRatio = normalizeRemainingRatio(
        credential.weeklyRemainingRatio
        ?? credential.quota?.weeklyRemainingRatio
    );
    const knownRatios = [fiveHourRemainingRatio, weeklyRemainingRatio].filter(value => value !== null);

    if (knownRatios.length === 0) {
        return {
            providerWeight,
            quotaFactor: explicitWeight === null ? DEFAULT_UNKNOWN_CAPACITY : 1,
            capacity: explicitWeight === null ? DEFAULT_UNKNOWN_CAPACITY : providerWeight,
            confidence: 'low',
            fiveHourRemainingRatio,
            weeklyRemainingRatio
        };
    }

    const quotaFactor = Math.min(...knownRatios);
    return {
        providerWeight,
        quotaFactor,
        capacity: providerWeight * quotaFactor,
        confidence: knownRatios.length === 2 ? 'high' : 'low',
        fiveHourRemainingRatio,
        weeklyRemainingRatio
    };
}

function isCredentialRouteAvailable(credential) {
    if (!isCredentialHealthy(credential)) return false;
    if (credential?.quotaAvailable === false || credential?.hasCapacity === false || credential?.isAtCapacity === true) {
        return false;
    }
    return calculateCredentialCapacity(credential).capacity > 0;
}

/**
 * Key 路由只有三种：pool（全部可用凭据）、fixed（1 份固定凭据）、restricted（2–5 份限定池）。
 * 历史 auto（主组优先）与 primaryGroupId 随凭据组移除，一律按 pool 处理。
 */
export function resolveKeyRoutingAssignment(keyData = {}) {
    const keyId = keyData?.id || keyData?.keyId ? String(keyData.id || keyData.keyId) : '';
    if (keyData?.routingMode === 'fixed') {
        return {
            keyId,
            routingMode: 'fixed',
            fixedCredential: keyData.fixedCredential?.uuid
                ? {
                    providerType: keyData.fixedCredential.providerType || 'openai-codex-oauth',
                    uuid: String(keyData.fixedCredential.uuid)
                }
                : null,
            restrictedCredentialUuids: []
        };
    }
    if (keyData?.routingMode === 'restricted') {
        return {
            keyId,
            routingMode: 'restricted',
            fixedCredential: null,
            restrictedCredentialUuids: (Array.isArray(keyData.restrictedCredentialUuids)
                ? keyData.restrictedCredentialUuids : []).map(String)
        };
    }
    return { keyId, routingMode: 'pool', fixedCredential: null, restrictedCredentialUuids: [] };
}

function indexByUuid(credentials) {
    return new Map(credentials
        .filter(credential => getCredentialUuid(credential))
        .map(credential => [getCredentialUuid(credential), credential]));
}

function getRecoveryTime(credential) {
    return credential?.scheduledRecoveryTime || credential?.config?.scheduledRecoveryTime || null;
}

export function routeKeyToCredentialCandidates(options = {}) {
    const keyRouting = resolveKeyRoutingAssignment(options.keyRouting || {});
    const credentials = options.credentials || [];
    const availableByUuid = new Map(
        credentials
            .filter(isCredentialRouteAvailable)
            .map(credential => [getCredentialUuid(credential), credential])
    );

    if (keyRouting.routingMode === 'fixed') {
        const fixed = keyRouting.fixedCredential;
        const credential = fixed?.uuid ? indexByUuid(credentials).get(fixed.uuid) : null;
        if (!credential) {
            return {
                routingMode: 'fixed',
                candidateProviderUuids: [],
                errorCode: 'ROUTE_MISMATCH',
                routeReason: 'FIXED_CREDENTIAL_NOT_FOUND'
            };
        }
        if (fixed.providerType && getCredentialProviderType(credential) !== fixed.providerType) {
            return {
                routingMode: 'fixed',
                candidateProviderUuids: [],
                errorCode: 'ROUTE_MISMATCH',
                routeReason: 'FIXED_PROVIDER_TYPE_MISMATCH'
            };
        }
        if (!availableByUuid.has(fixed.uuid)) {
            return {
                routingMode: 'fixed',
                candidateProviderUuids: [],
                errorCode: 'FIXED_CREDENTIAL_UNAVAILABLE',
                routeReason: 'FIXED_CREDENTIAL_NOT_HEALTHY',
                nextRecoveryTime: getRecoveryTime(credential)
            };
        }
        return { routingMode: 'fixed', candidateProviderUuids: [fixed.uuid], errorCode: null };
    }

    if (keyRouting.routingMode === 'restricted') {
        const uuids = keyRouting.restrictedCredentialUuids;
        const allByUuid = indexByUuid(credentials);
        const valid = uuids.length >= MIN_RESTRICTED_CREDENTIALS && uuids.length <= MAX_RESTRICTED_CREDENTIALS
            && new Set(uuids).size === uuids.length
            && uuids.every(uuid => !allByUuid.has(uuid)
                || getCredentialProviderType(allByUuid.get(uuid)) === 'openai-codex-oauth');
        const candidates = valid ? uuids.filter(uuid => availableByUuid.has(uuid)) : [];
        const nextRecoveryTime = candidates.length ? null : uuids
            .map(uuid => getRecoveryTime(allByUuid.get(uuid)))
            .filter(value => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now())
            .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null;
        return {
            routingMode: 'restricted',
            candidateProviderUuids: candidates,
            restrictedCredentialUuids: uuids,
            nextRecoveryTime,
            errorCode: !valid ? 'ROUTE_MISMATCH'
                : candidates.length ? null : nextRecoveryTime ? 'PROVIDER_COOLDOWN' : 'RESTRICTED_CREDENTIALS_UNAVAILABLE'
        };
    }

    return {
        routingMode: 'pool',
        candidateProviderUuids: [...availableByUuid.keys()],
        errorCode: null
    };
}
