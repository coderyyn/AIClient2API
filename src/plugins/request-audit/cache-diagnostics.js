const LOW_CACHE_RATIO = 0.2;
const SHORT_PROMPT_TOKENS = 1200;

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function cacheHitRatio(event) {
    const promptTokens = toNumber(event?.usage?.promptTokens);
    return promptTokens > 0 ? toNumber(event?.usage?.cachedTokens) / promptTokens : 0;
}

function keyHash(event) {
    return event?.potluckKey?.hash || null;
}

function accountId(event) {
    return event?.account?.providerUuid || event?.account?.providerNameDisplay || null;
}

function modelId(event) {
    return event?.request?.model || null;
}

function sameValue(left, right) {
    return left && right && left === right;
}

function prefixHashMap(event) {
    const map = new Map();
    for (const item of event?.fingerprint?.prefixHashes || []) {
        if (item?.chars && item?.hash) map.set(item.chars, item.hash);
    }
    return map;
}

function sharedStablePrefix(current, previous) {
    const currentMap = prefixHashMap(current);
    const previousMap = prefixHashMap(previous);
    for (const [chars, hash] of currentMap) {
        if (previousMap.get(chars) === hash) return true;
    }
    return false;
}

function hasComparablePrefix(current, previous) {
    const currentMap = prefixHashMap(current);
    const previousMap = prefixHashMap(previous);
    for (const chars of currentMap.keys()) {
        if (previousMap.has(chars)) return true;
    }
    return false;
}

function comparableScore(current, candidate) {
    let score = 0;
    if (sameValue(keyHash(current), keyHash(candidate))) score += 8;
    if (sameValue(modelId(current), modelId(candidate))) score += 4;
    if (sameValue(accountId(current), accountId(candidate))) score += 4;
    if (sharedStablePrefix(current, candidate)) score += 3;
    if (current?.fingerprint?.toolsHash && current.fingerprint.toolsHash === candidate?.fingerprint?.toolsHash) score += 2;
    if (current?.fingerprint?.instructionsHash && current.fingerprint.instructionsHash === candidate?.fingerprint?.instructionsHash) score += 2;
    return score;
}

function findComparable(current, candidates = []) {
    return candidates
        .filter(candidate => candidate && candidate.requestId !== current?.requestId)
        .filter(candidate => sameValue(keyHash(current), keyHash(candidate)))
        .sort((a, b) => comparableScore(current, b) - comparableScore(current, a))[0] || null;
}

function addReason(reasons, code, severity, evidence = {}) {
    reasons.push({ code, severity, evidence });
}

function primaryReason(reasons) {
    const order = [
        'short_prompt_or_low_cacheable_input',
        'prefix_changed',
        'tools_changed',
        'instructions_changed',
        'attachment_or_multimodal_variance',
        'account_changed',
        'model_changed',
        'unknown_or_upstream_cache_ttl'
    ];
    return order.find(code => reasons.some(reason => reason.code === code)) || reasons[0]?.code || 'unknown_or_upstream_cache_ttl';
}

function confidenceFor(reasons) {
    if (reasons.some(reason => reason.severity === 'high')) return 0.85;
    if (reasons.some(reason => reason.severity === 'medium')) return 0.65;
    return 0.35;
}

export function diagnoseCacheMiss(event, candidates = []) {
    const ratio = cacheHitRatio(event);
    const reasons = [];
    const comparable = findComparable(event, candidates);
    const promptTokens = toNumber(event?.usage?.promptTokens);

    if (promptTokens > 0 && promptTokens < SHORT_PROMPT_TOKENS) {
        addReason(reasons, 'short_prompt_or_low_cacheable_input', 'high', {
            promptTokens,
            threshold: SHORT_PROMPT_TOKENS
        });
    }

    if (comparable) {
        if (hasComparablePrefix(event, comparable) && !sharedStablePrefix(event, comparable)) {
            addReason(reasons, 'prefix_changed', 'high', {
                comparableRequestId: comparable.requestId
            });
        }
        if (event?.fingerprint?.toolsHash && comparable?.fingerprint?.toolsHash && event.fingerprint.toolsHash !== comparable.fingerprint.toolsHash) {
            addReason(reasons, 'tools_changed', 'high', {
                current: event.fingerprint.toolsHash,
                comparable: comparable.fingerprint.toolsHash
            });
        }
        if (event?.fingerprint?.instructionsHash && comparable?.fingerprint?.instructionsHash && event.fingerprint.instructionsHash !== comparable.fingerprint.instructionsHash) {
            addReason(reasons, 'instructions_changed', 'high', {
                current: event.fingerprint.instructionsHash,
                comparable: comparable.fingerprint.instructionsHash
            });
        }
        if (accountId(event) && accountId(comparable) && accountId(event) !== accountId(comparable)) {
            addReason(reasons, 'account_changed', 'medium', {
                current: accountId(event),
                comparable: accountId(comparable)
            });
        }
        if (modelId(event) && modelId(comparable) && modelId(event) !== modelId(comparable)) {
            addReason(reasons, 'model_changed', 'medium', {
                current: modelId(event),
                comparable: modelId(comparable)
            });
        }
    }

    if (toNumber(event?.fingerprint?.sections?.attachments?.count) > 0) {
        addReason(reasons, 'attachment_or_multimodal_variance', 'medium', {
            attachmentCount: toNumber(event.fingerprint.sections.attachments.count)
        });
    }

    if (reasons.length === 0) {
        addReason(reasons, 'unknown_or_upstream_cache_ttl', 'low', {
            comparableRequestId: comparable?.requestId || null
        });
    }

    return {
        requestId: event?.requestId || null,
        cacheHitRatio: ratio,
        primaryReason: primaryReason(reasons),
        reasons,
        comparableRequestId: comparable?.requestId || null,
        confidence: confidenceFor(reasons)
    };
}

export function buildDiagnostics(events = []) {
    const sorted = [...events].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    const diagnostics = [];
    for (let index = 0; index < sorted.length; index += 1) {
        const event = sorted[index];
        if (cacheHitRatio(event) >= LOW_CACHE_RATIO) continue;
        diagnostics.push(diagnoseCacheMiss(event, sorted.slice(0, index)));
    }
    return diagnostics;
}
