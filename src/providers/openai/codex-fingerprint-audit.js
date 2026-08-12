import crypto from 'crypto';

const auditByProviderUuid = new Map();

function shortHash(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function recordCodexFingerprintAudit(providerConfig = {}, ids = null, mode = 'off') {
    const uuid = String(providerConfig.uuid || '').trim();
    if (!uuid) return null;

    const summary = {
        mode,
        version: ids?.version || providerConfig.codexFingerprintVersion || 1,
        rewritten: Boolean(ids),
        rewrittenAt: new Date().toISOString(),
        installationHash: shortHash(ids?.installationId),
        sessionHash: shortHash(ids?.sessionId),
        threadHash: shortHash(ids?.threadId),
        turnHash: shortHash(ids?.turnId)
    };
    auditByProviderUuid.set(uuid, summary);
    return summary;
}

export function getCodexFingerprintAudit(providerUuid) {
    return auditByProviderUuid.get(String(providerUuid || '').trim()) || null;
}

export function clearCodexFingerprintAudit() {
    auditByProviderUuid.clear();
}
