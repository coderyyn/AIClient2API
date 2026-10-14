import { randomUUID, createHash } from 'node:crypto';

export const ANTIGRAVITY_PROVIDER = 'gemini-antigravity';

export function cooldownVersion(state) {
    return state?.version || createHash('sha256').update(JSON.stringify(state || null)).digest('hex');
}

export function versionCooldown(state, at = Date.now()) {
    return { ...state, version: randomUUID(), updatedAt: new Date(at).toISOString() };
}

export function cooldownProbeEligible(config, state, now = Date.now()) {
    const recovery = Date.parse(state?.scheduledRecoveryTime || '');
    return Boolean(config?.uuid && !config.isArchived && !config.isDisabled && !config.needsRefresh && config.isHealthy !== false
        && state?.isHealthy === false && (!Number.isFinite(recovery) || recovery > now));
}

export function normalizeProbeModel(model) {
    return String(model || '').trim().replace(/^gemini-antigravity:/, '').replace(/^models\//, '');
}
