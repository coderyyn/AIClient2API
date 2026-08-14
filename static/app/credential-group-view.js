const DEFAULT_FOCUS_SHARE = 0.8;

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function keyStableRef(key = {}) {
    return String(key.maskedKey || key.keyRef || key.keyId || '');
}

function keySortCategory(key = {}) {
    if (key.enabled === false) return 2;
    return finiteNumber(key?.demand?.totalTokens) > 0 ? 0 : 1;
}

export function sortCredentialGroupKeys(keys = []) {
    return [...keys].sort((left, right) => {
        const categoryDelta = keySortCategory(left) - keySortCategory(right);
        if (categoryDelta !== 0) return categoryDelta;

        const tokenDelta = finiteNumber(right?.demand?.totalTokens) - finiteNumber(left?.demand?.totalTokens);
        if (tokenDelta !== 0) return tokenDelta;

        const requestDelta = finiteNumber(right?.demand?.requestCount) - finiteNumber(left?.demand?.requestCount);
        if (requestDelta !== 0) return requestDelta;

        return keyStableRef(left).localeCompare(keyStableRef(right));
    });
}

export function getFocusedCredentialGroupKeys(keys = [], focusShare = DEFAULT_FOCUS_SHARE) {
    const all = sortCredentialGroupKeys(keys);
    const activeWithUsage = all.filter(key => key.enabled !== false && finiteNumber(key?.demand?.totalTokens) > 0);
    const totalTokens = activeWithUsage.reduce((sum, key) => sum + finiteNumber(key?.demand?.totalTokens), 0);
    const normalizedShare = Math.max(0, Math.min(1, finiteNumber(focusShare) || DEFAULT_FOCUS_SHARE));
    const visibleRefs = new Set();
    let coveredTokens = 0;

    for (const key of activeWithUsage) {
        if (totalTokens <= 0 || coveredTokens / totalTokens >= normalizedShare) break;
        visibleRefs.add(keyStableRef(key));
        coveredTokens += finiteNumber(key?.demand?.totalTokens);
    }

    all.forEach(key => {
        const isOperationalException = key.enabled !== false
            && (key.routingMode === 'fixed' || key.manualLock === true);
        if (isOperationalException) visibleRefs.add(keyStableRef(key));
    });

    const visible = all.filter(key => visibleRefs.has(keyStableRef(key)));
    return {
        all,
        visible,
        hiddenCount: Math.max(0, all.length - visible.length),
        totalTokens,
        coveredTokens
    };
}

function credentialStableRef(credential = {}) {
    return String(credential.credentialRef || '');
}

export function getFocusedCredentials(credentials = []) {
    const all = [...credentials].sort((left, right) => {
        const capacityDelta = finiteNumber(right?.capacity) - finiteNumber(left?.capacity);
        if (capacityDelta !== 0) return capacityDelta;
        return credentialStableRef(left).localeCompare(credentialStableRef(right));
    });
    const visible = all.filter(credential => credential.available === true
        && credential.isHealthy !== false
        && credential.isDisabled !== true
        && credential.needsRefresh !== true
        && finiteNumber(credential.capacity) > 0);

    return {
        all,
        visible,
        hiddenCount: Math.max(0, all.length - visible.length)
    };
}
