import requestContext from '../utils/context.js';
import { getNextQuotaResetTime } from '../utils/quota-reset-time.js';
import { getProviderModels } from '../providers/provider-models.js';
import { resolveCodexOutboundModel } from '../providers/openai/codex-model-capabilities.js';
import { resolveCodexSparkAlias, createUnsupportedCodexModelError } from '../providers/openai/codex-model-routing.js';
import { getProviderLeaseScope, registerProviderLease } from '../runtime/provider-lease-scope.js';
import { resolveKeyRoutingAssignment } from './codex-key-routing.js';

export const MIXED_CODEX = 'openai-codex-oauth';
export const MIXED_KEY = 'openaiResponses-custom';
export const MIXED_POLICY_ERROR = 'PROVIDER_POLICY_CHANGED';
const baseModel = model => String(model || '').replace(/-(fast|ultrafast)$/, '');

export function normalizeMixedModel(model) {
    const value = String(model || '').trim().toLowerCase().replace(/^openai-codex-oauth:/, '');
    return resolveCodexSparkAlias(value) || value;
}

export function isMixedTextModel(model) {
    return /^gpt-(?!image(?:-|$))/.test(normalizeMixedModel(model));
}

export function isLunaModel(model) {
    return /-luna(?:-(?:fast|ultrafast))?$/.test(normalizeMixedModel(model));
}

export function mixedCandidateRejection(type, provider, model) {
    if (!provider || provider.isDisabled || provider.isArchived) return 'DISABLED';
    if (provider.isHealthy === false || provider.needsRefresh) return 'UNHEALTHY';
    if (Date.parse(provider.scheduledRecoveryTime) > Date.now()) return 'COOLDOWN';
    if (type === MIXED_CODEX) {
        if (!isLunaModel(model) && provider.codexAllowNonLuna === false) return 'LUNA_ONLY';
        if (!getProviderModels(type).includes(model) || provider.notSupportedModels?.includes(model)) return 'MODEL_UNSUPPORTED';
        if (baseModel(resolveCodexOutboundModel(model, provider)) !== baseModel(model)) return 'MODEL_REMAP_CONFLICT';
    } else if (type === MIXED_KEY) {
        if (!Array.isArray(provider.supportedModels) || !provider.supportedModels.includes(model)) return 'MODEL_CATALOG_UNAVAILABLE';
    } else return 'PROVIDER_UNSUPPORTED';
    return null;
}

function unavailable(code = 'PROVIDER_CREDENTIALS_UNAVAILABLE') {
    return Object.assign(new Error('No eligible GPT credential is available'), {
        status: 503, statusCode: 503, code, skipErrorCount: true
    });
}

function coordinationFailure() {
    return Object.assign(new Error('GPT routing coordination is unavailable'), {
        status: 503, statusCode: 503, code: 'COORDINATION_UNAVAILABLE', skipErrorCount: true, origin: 'local_provider_policy'
    });
}

// Called only from the model-request entrypoint. No prompt or credential is
// retained in the routing state or response binding.
export function prepareMixedRequest(config, model, body, path, isImageRequest = false) {
    if (isImageRequest || !/\/v1\/(?:responses|chat\/completions)$/.test(path || '')) {
        requestContext.set('gptRequestPolicy', null);
        return;
    }
    requestContext.set('gptRequestPolicy', {
        entryProvider: config.MODEL_PROVIDER,
        model: normalizeMixedModel(model),
        previousResponseId: typeof body?.previous_response_id === 'string' ? body.previous_response_id : null
    });
}

export async function selectMixedRoute(manager, config, requestedModel, options = {}) {
    const policy = requestContext.get('gptRequestPolicy');
    if (!policy || config.GPT_MIXED_ROUTING_ENABLED !== true || !manager) return null;
    const previousState = requestContext.get('gptMixedState');
    if (config._temporaryKeyModelRoute || options.routingStrategy === 'image-round-robin') return null;
    const model = normalizeMixedModel(requestedModel);
    if (!isMixedTextModel(model) || isLunaModel(model)) return null;
    const explicitPrefix = String(requestedModel || '').split(':');
    if (explicitPrefix.length > 1 && explicitPrefix[0] !== MIXED_CODEX) return null;
    const entryProvider = explicitPrefix.length > 1 ? explicitPrefix[0] : config.MODEL_PROVIDER;
    if ((entryProvider !== MIXED_CODEX || policy.entryProvider === MIXED_KEY) && !previousState?.selection) return null;
    const routing = resolveKeyRoutingAssignment(config.potluckKeyData || {});
    // These paths already enforce their own account ownership and group rules.
    // They never gain access to the API-key pool from mixed routing.
    if (routing.routingMode !== 'pool') return null;
    if (!manager.coordination?.getMixedResponseBinding) throw coordinationFailure();
    const keyRef = getProviderLeaseScope().keyRef || 'anonymous';
    let binding = null;
    if (policy.previousResponseId) {
        try {
            binding = await manager.coordination.getMixedResponseBinding(keyRef, policy.previousResponseId);
        } catch {
            throw coordinationFailure();
        }
        if (!binding) return null;
    }
    const rejected = {};
    const candidates = [];
    const excluded = new Set(options.excludeProviderUuids || []);
    const attemptedCandidates = previousState?.attemptedCandidates || new Set();
    if (previousState?.selection) {
        attemptedCandidates.add(`${previousState.selection.providerType}:${previousState.selection.uuid}`);
    }
    const candidateOptions = previousState ? { ...options, excludeProviderUuids: [] } : options;
    for (const type of [MIXED_CODEX, MIXED_KEY]) {
        await manager._hydrateCodexPoolSnapshot(type, manager.providerStatus[type] || [], model);
        let healthy;
        try {
            healthy = await manager._getHealthyProvidersForType(type, model, candidateOptions);
        } catch (error) {
            if (Number(error.status || error.statusCode) !== 429 || !error.filterReasons) throw error;
            // Exhaustion in one pool must not prevent considering the other pool.
            healthy = [];
        }
        const healthyIds = new Set(healthy.map(p => p.uuid || p.config.uuid));
        for (const item of manager.providerStatus[type] || []) {
            const provider = item.config;
            let reason = mixedCandidateRejection(type, provider, model);
            if (!healthyIds.has(provider.uuid)) reason ||= 'QUOTA_OR_HEALTH';
            if (attemptedCandidates.has(`${type}:${provider.uuid}`) || (!previousState && excluded.has(provider.uuid))) reason ||= 'ALREADY_TRIED';
            if (binding && (binding.providerType !== type || binding.uuid !== provider.uuid)) reason ||= 'CONTINUATION_BOUND';
            if (reason) {
                rejected[`${type}:${provider.uuid}`] = reason;
                continue;
            }
            candidates.push({
                providerType: type,
                uuid: provider.uuid,
                concurrencyLimit: provider.concurrencyLimit || 0,
                rpmLimit: type === MIXED_CODEX ? provider.rpmLimit || 0 : 0,
                mixedResetAt: type === MIXED_KEY
                    ? getNextQuotaResetTime(provider.quotaResetDay, provider.quotaResetTimezone) || 0 : 0
            });
        }
    }
    if (!candidates.length) {
        if (binding) throw unavailable('GPT_CONTINUATION_UNAVAILABLE');
        if (Object.values(rejected).length && Object.values(rejected).every(r => ['MODEL_UNSUPPORTED', 'MODEL_CATALOG_UNAVAILABLE', 'MODEL_REMAP_CONFLICT'].includes(r))) {
            throw createUnsupportedCodexModelError(model);
        }
        throw unavailable();
    }
    const scope = `${model}:${candidates.map(c => `${c.providerType}:${c.uuid}`).sort().join(',')}`;
    let lease;
    try {
        lease = await manager.coordination.acquire(candidates, { requestedModel: model, mixedScope: scope });
    } catch (error) {
        if (error.status || error.statusCode) throw error;
        throw coordinationFailure();
    }
    if (!lease) throw unavailable();
    const provider = manager._findProvider(lease.providerType, lease.uuid)?.config;
    if (mixedCandidateRejection(lease.providerType, provider, model)) {
        await manager.coordination.release(lease.leaseId);
        throw unavailable(MIXED_POLICY_ERROR);
    }
    await registerProviderLease(getProviderLeaseScope(), manager.coordination, lease, model);
    const selection = { providerType: lease.providerType, uuid: lease.uuid, model };
    requestContext.set('gptMixedState', { manager, selection, keyRef, attemptedCandidates, binding: Boolean(binding), boundIds: new Set() });
    const metadata = { reason: binding ? 'CONTINUATION_BOUND' : lease.mixedReason || 'EQUAL_SHARE',
        selectedProviderType: lease.providerType, selectedProviderUuid: lease.uuid, excluded: rejected };
    config._modelRouting = { requestedModel: model, actualModel: model, gptMixed: metadata };
    return { provider, selection, model, metadata };
}

export async function validateMixedSend(type, uuid) {
    const state = requestContext.get('gptMixedState');
    const policy = requestContext.get('gptRequestPolicy');
    if (!state && !policy) return;
    let manager = state?.manager;
    if (!manager) {
        const { getProviderPoolManager } = await import('./service-manager.js');
        manager = getProviderPoolManager();
    }
    if (!state && manager?.globalConfig?.GPT_MIXED_ROUTING_ENABLED !== true && type !== MIXED_KEY) return;
    if (!manager) return;
    const model = state?.selection?.model || policy?.model;
    if (!isMixedTextModel(model)) return;
    const provider = manager?._findProvider(type, uuid)?.config;
    // Legacy continuation and explicitly fixed routes retain model remapping,
    // but always honor a disabled credential and its Luna-only switch.
    let reason = null;
    if (state) reason = mixedCandidateRejection(type, provider, model);
    else if (!provider || provider.isDisabled || provider.isArchived) reason = 'DISABLED';
    else if (type === MIXED_CODEX && !isLunaModel(model) && provider.codexAllowNonLuna === false) reason = 'LUNA_ONLY';
    if (reason) throw Object.assign(unavailable(state?.binding ? 'GPT_CONTINUATION_UNAVAILABLE' : MIXED_POLICY_ERROR), {
        origin: 'local_provider_policy', shouldSwitchCredential: !state?.binding, skipErrorCount: true,
        details: { reason }, retryAfterMs: 1000
    });
}

export function hasMixedNativeAttempts(type) {
    return type === MIXED_KEY && Boolean(requestContext.get('gptMixedState')?.selection);
}

export async function bindMixedResponse(value) {
    const state = requestContext.get('gptMixedState');
    if (!state?.selection) return;
    const id = value?.response?.id || (value?.object === 'response' || value?.output ? value?.id : null);
    if (typeof id !== 'string' || !id || state.boundIds.has(id)) return;
    try {
        await state.manager.coordination.setMixedResponseBinding(state.keyRef, id, state.selection);
    } catch {
        throw coordinationFailure();
    }
    state.boundIds.add(id);
}

export function wrapMixedService(service) {
    const wrapped = Object.create(service);
    wrapped.generateContent = async (...args) => {
        const result = await service.generateContent(...args);
        await bindMixedResponse(result);
        return result;
    };
    wrapped.generateContentStream = async function* (...args) {
        for await (const event of service.generateContentStream(...args)) {
            await bindMixedResponse(event);
            yield event;
        }
    };
    return wrapped;
}
