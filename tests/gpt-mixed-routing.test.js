import { jest, test, expect, beforeEach } from '@jest/globals';
import requestContext from '../src/utils/context.js';
import { isImageGenerationRequest } from '../src/utils/common.js';
import { mixedCandidateRejection, normalizeMixedModel, isLunaModel, isMixedTextModel,
    selectMixedRoute, prepareMixedRequest, validateMixedSend, bindMixedResponse, MIXED_KEY, MIXED_CODEX } from '../src/services/gpt-mixed-routing.js';
import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';
import { createCredentialManifest, fingerprintCredentialManifest } from '../src/runtime/credential-manifest.js';

const model = 'gpt-6-sol';
const provider = (uuid, extra = {}) => ({ uuid, isHealthy: true, supportedModels: [model], ...extra });
function manager(codex = [], keys = []) {
    const m = { providerStatus: { [MIXED_CODEX]: codex.map(config => ({ config })), [MIXED_KEY]: keys.map(config => ({ config })) },
        _hydrateCodexPoolSnapshot: jest.fn(async () => {}),
        coordination: { getMixedResponseBinding: jest.fn(async () => null), setMixedResponseBinding: jest.fn(async () => {}),
            acquire: jest.fn(async cs => ({ providerType: cs[0].providerType, uuid: cs[0].uuid, leaseId: 'test-lease', mixedReason: 'EQUAL_SHARE' })),
            release: jest.fn(async () => {}) } };
    m._getHealthyProvidersForType = async type => m.providerStatus[type];
    m._findProvider = (type, uuid) => m.providerStatus[type]?.find(p => p.config.uuid === uuid);
    return m;
}
const config = () => ({ MODEL_PROVIDER: MIXED_CODEX, GPT_MIXED_ROUTING_ENABLED: true, potluckKeyData: { id: 'client-key', routingMode: 'pool' } });

beforeEach(() => requestContext.getStore().gptMixedState = null);

test('classifies Luna aliases and excludes images', () => {
    expect(normalizeMixedModel('openai-codex-oauth:gpt-5.3-codex-spark')).toBe('gpt-6-luna');
    expect(isLunaModel('gpt-6-luna-fast')).toBe(true);
    expect(isMixedTextModel('gpt-image-2')).toBe(false);
    expect(isMixedTextModel('gemini-2.5-flash')).toBe(false);
});

test('old Codex config participates; disabled, Luna-only, remapped and unknown-catalog candidates are excluded', () => {
    expect(mixedCandidateRejection(MIXED_CODEX, provider('old'), model)).toBeNull();
    expect(mixedCandidateRejection(MIXED_CODEX, provider('off', { codexAllowNonLuna: false }), model)).toBe('LUNA_ONLY');
    expect(mixedCandidateRejection(MIXED_CODEX, provider('off', { codexAllowNonLuna: false }), 'gpt-6-luna')).toBeNull();
    expect(mixedCandidateRejection(MIXED_CODEX, provider('remap', { codexGpt6OverrideEnabled: true }), model)).toBe('MODEL_REMAP_CONFLICT');
    expect(mixedCandidateRejection(MIXED_KEY, provider('empty', { supportedModels: [] }), model)).toBe('MODEL_CATALOG_UNAVAILABLE');
    expect(mixedCandidateRejection(MIXED_KEY, provider('disabled', { isDisabled: true }), model)).toBe('DISABLED');
});

test('provider flag is strict boolean and changes the worker manifest', () => {
    expect(() => normalizeProviderConfigFields({ codexAllowNonLuna: 'false' })).toThrow();
    const manifest = flag => fingerprintCredentialManifest(createCredentialManifest({ [MIXED_CODEX]: [provider('a', { codexAllowNonLuna: flag })] }));
    expect(manifest(true)).not.toBe(manifest(false));
});

test('mixed selection combines eligible types, preserves restricted routes and observes send-time disablement', async () => requestContext.run({}, async () => {
    const cfg = config();const m = manager([provider('a')], [provider('b')]);
    prepareMixedRequest(cfg, model, {}, '/v1/responses');
    const selected = await selectMixedRoute(m, cfg, model, {});
    expect(m.coordination.acquire.mock.calls[0][0].map(c => c.providerType)).toEqual([MIXED_CODEX, MIXED_KEY]);
    expect(selected.selection.uuid).toBe('a');
    m.providerStatus[MIXED_CODEX][0].config.codexAllowNonLuna = false;
    await expect(validateMixedSend(MIXED_CODEX, 'a')).rejects.toMatchObject({ code: 'PROVIDER_POLICY_CHANGED', skipErrorCount: true });
    expect(await selectMixedRoute(m, { ...config(), potluckKeyData: { routingMode: 'fixed' } }, model)).toBeNull();
    expect(await selectMixedRoute(m, { ...config(), GPT_MIXED_ROUTING_ENABLED: false }, model)).toBeNull();
}));

test('continuations use only their bound credential, unknown historical IDs retain the legacy path, and bindings omit secrets', async () => requestContext.run({}, async () => {
    const cfg = config();const m = manager([provider('a')], [provider('b')]);
    prepareMixedRequest(cfg, model, { previous_response_id: 'response-old' }, '/v1/responses');
    expect(await selectMixedRoute(m, cfg, model)).toBeNull();
    m.coordination.getMixedResponseBinding.mockResolvedValue({ providerType: MIXED_KEY, uuid: 'b', model });
    await selectMixedRoute(m, cfg, model);
    expect(m.coordination.acquire.mock.calls[0][0]).toHaveLength(1);
    await bindMixedResponse({ type: 'response.created', response: { id: 'response-new', secret: 'do-not-store' } });
    expect(JSON.stringify(m.coordination.setMixedResponseBinding.mock.calls)).not.toContain('do-not-store');
    m.providerStatus[MIXED_KEY][0].config.isDisabled = true;
    await expect(validateMixedSend(MIXED_KEY, 'b')).rejects.toMatchObject({ code: 'GPT_CONTINUATION_UNAVAILABLE' });
}));

test('Codex continuation stays on its bound account and follows the existing stateless input path', async () => requestContext.run({}, async () => {
    const cfg = config();
    const m = manager([provider('codex-bound')], [provider('key-other')]);
    m.coordination.getMixedResponseBinding.mockResolvedValue({ providerType: MIXED_CODEX, uuid: 'codex-bound', model });
    prepareMixedRequest(cfg, model, { previous_response_id: 'codex-response', input: 'full client input' }, '/v1/responses');
    const selected = await selectMixedRoute(m, cfg, model);
    expect(selected.selection).toEqual({ providerType: MIXED_CODEX, uuid: 'codex-bound', model });
    await expect(validateMixedSend(MIXED_CODEX, 'codex-bound')).resolves.toBeUndefined();
    m.providerStatus[MIXED_CODEX][0].config.codexAllowNonLuna = false;
    await expect(validateMixedSend(MIXED_CODEX, 'codex-bound')).rejects.toMatchObject({ code: 'GPT_CONTINUATION_UNAVAILABLE' });
}));

test('image endpoints and explicitly scoped model routes keep their existing routing', async () => requestContext.run({}, async () => {
    const cfg = config();
    const m = manager([provider('a')], [provider('b')]);
    prepareMixedRequest(cfg, model, {}, '/v1/images/generations');
    expect(await selectMixedRoute(m, cfg, model)).toBeNull();
    prepareMixedRequest(cfg, model, {}, '/v1/responses');
    expect(await selectMixedRoute(m, { ...cfg, _temporaryKeyModelRoute: { id: 'explicit-route' } }, model)).toBeNull();
    expect(await selectMixedRoute(m, { ...cfg, MODEL_PROVIDER: MIXED_KEY }, model)).toBeNull();
    expect(m.coordination.acquire).not.toHaveBeenCalled();
}));

test('Responses image-generation tools and internal image routing never enter mixed text routing', async () => requestContext.run({}, async () => {
    const cfg = config();
    const m = manager([provider('a')], [provider('b')]);
    const body = { model, tools: [{ type: 'image_generation' }] };
    const path = '/v1/responses';
    prepareMixedRequest(cfg, model, body, path, isImageGenerationRequest({ requestPath: path, model, body }));
    expect(await selectMixedRoute(m, cfg, model)).toBeNull();
    prepareMixedRequest(cfg, model, {}, path);
    expect(await selectMixedRoute(m, cfg, model, { routingStrategy: 'image-round-robin' })).toBeNull();
    expect(m.coordination.acquire).not.toHaveBeenCalled();
}));
