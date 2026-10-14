import { jest, test, expect, afterEach } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { AntigravityCooldownProbeService, validateCooldownProbeResponse } from '../src/services/antigravity-cooldown-probe-service.js';
import { getAntigravityExplicitRecoveryTime } from '../src/utils/common.js';
import { createProviderStateEvent, applyProviderStateEvent } from '../src/runtime/provider-state-event.js';

jest.mock('../src/providers/adapter.js', () => ({ getServiceAdapter: jest.fn(), getRegisteredProviders: () => [], invalidateServiceAdapter: jest.fn() }));
jest.mock('../src/providers/gemini/antigravity-core.js', () => ({ AntigravityApiService: jest.fn() }));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

const type = 'gemini-antigravity', model = 'gemini-2.5-flash';
const log = { info: jest.fn(), warn: jest.fn() };
const managers = [];
const cool = () => ({ isHealthy: false, lastErrorTime: new Date(Date.now() - 60_000).toISOString(),
    scheduledRecoveryTime: new Date(Date.now() + 3600_000).toISOString(), source: 'upstream_429' });
const provider = (uuid = 'one', overrides = {}) => ({ uuid, isHealthy: true, isDisabled: false,
    concurrencyLimit: 1, antigravityQuotaHealth: { families: {}, models: { [model]: cool() } }, ...overrides });
const answer = (text = '43', reported = model) => ({ http: 200, response: { modelVersion: reported,
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] } });
function setup(providers = [provider()], config = {}, coordination = null) {
    const manager = new ProviderPoolManager({ [type]: providers }, { persistenceEnabled: false, logLevel: 'error', globalConfig: config, coordination });
    managers.push(manager);
    // Runtime refresh flags are set after the manager's cold-start repair.
    for (const p of providers) if (p.uuid === 'auth') manager._findProvider(type, p.uuid).config.needsRefresh = true;
    const generate = jest.fn(async () => answer());
    const factory = jest.fn(() => ({ probeCooldownModel: generate }));
    const service = new AntigravityCooldownProbeService(config, manager, { log, serviceFactory: factory, multiWorker: false });
    return { manager, generate, factory, service };
}
afterEach(() => {
    for (const m of managers.splice(0)) { clearTimeout(m.saveTimer); clearTimeout(m.stateEventTimer); }
    jest.useRealTimers(); jest.clearAllMocks();
});

test('only eligible Gemini model cooldowns are probed, without changing account or sibling state', async () => {
    const eligible = provider();
    eligible.antigravityQuotaHealth.models['gemini-claude-sonnet-4'] = cool();
    eligible.antigravityQuotaHealth.models['gemini-3-flash'] = { isHealthy: true };
    const { service, generate, manager } = setup([eligible, provider('disabled', { isDisabled: true }),
        provider('auth', { needsRefresh: true }), provider('unhealthy', { isHealthy: false }),
        provider('empty', { antigravityQuotaHealth: { models: {} } })]);
    await service.runOnce();
    expect(generate).toHaveBeenCalledTimes(1);
    const target = manager._findProvider(type, 'one');
    expect(target.config.antigravityQuotaHealth.models[model]).toMatchObject({ isHealthy: true, scheduledRecoveryTime: null, lastErrorMessage: null, source: 'cooldown_probe' });
    expect(target.config.antigravityQuotaHealth.models['gemini-claude-sonnet-4'].isHealthy).toBe(false);
    expect(target.config.isHealthy).toBe(true);
    expect(target.state.activeCount).toBe(0);
    await manager._filterAntigravityProvidersByQuota(type, [target], model);
    expect(target.config.antigravityQuotaHealth.models[model].isHealthy).toBe(true);
    await service.runOnce();
    expect(generate).toHaveBeenCalledTimes(1);
});

test('empty pools, disabled switch and missing multi-worker coordination produce zero requests', async () => {
    const a = setup([]); await a.service.runOnce(); expect(a.generate).not.toHaveBeenCalled();
    const b = setup(undefined, { ANTIGRAVITY_COOLDOWN_PROBE_ENABLED: false }); await b.service.runOnce(); expect(b.generate).not.toHaveBeenCalled();
    const c = setup(); c.service.multiWorker = true; await c.service.runOnce(); expect(c.generate).not.toHaveBeenCalled();
});

test('starts only after ten minutes and does not overlap sweeps', async () => {
    jest.useFakeTimers();
    const { service, generate } = setup();
    let finish;
    generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    service.start();
    await jest.advanceTimersByTimeAsync(599_999); expect(generate).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(generate).toHaveBeenCalledTimes(1);
    const running = service.runOnce(); expect(running).toBe(service.running);
    finish(answer()); await running;
    await service.stop(); await jest.advanceTimersByTimeAsync(600_000);
    expect(generate).toHaveBeenCalledTimes(1);
});

test.each(['retired model', '', '44'])('HTTP 200 with any answer %s recovers the text model', async text => {
    const { service, generate, manager } = setup();
    generate.mockResolvedValue(answer(text)); await service.runOnce();
    expect(manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model].isHealthy).toBe(true);
});

test('text recovery needs only a successful response from the target model', async () => {
    expect(await validateCooldownProbeResponse(model, answer('43', 'gemini-3-flash').response)).toBe(false);
    expect(await validateCooldownProbeResponse(model, { modelVersion: model, candidates: [] })).toBe(false);
    const r = answer('not the answer').response; r.candidates[0].finishReason = 'MAX_TOKENS';
    expect(await validateCooldownProbeResponse(model, r)).toBe(true);
});

test('image recovery requires a fully decodable image, not a text response or image header', async () => {
    const imageModel = 'gemini-3.1-flash-image';
    expect(await validateCooldownProbeResponse(imageModel, answer('43', imageModel).response)).toBe(false);
    const sharp = (await import('sharp')).default;
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const r = answer('', imageModel).response;
    r.candidates[0].content.parts = [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }];
    expect(await validateCooldownProbeResponse(imageModel, r)).toBe(true);
    r.candidates[0].content.parts[0].inlineData.data = image.subarray(0, 20).toString('base64');
    expect(await validateCooldownProbeResponse(imageModel, r)).toBe(false);
});

test.each(['10m', '2h'])('429 updates deadline in either direction: %s', async delay => {
    const { service, generate, manager } = setup();
    const before = manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model].scheduledRecoveryTime;
    generate.mockRejectedValue({ response: { status: 429, data: { error: { message: `Quota will reset after ${delay}.` } } } });
    await service.runOnce();
    const after = manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model];
    expect(after.isHealthy).toBe(false); expect(after.scheduledRecoveryTime).not.toBe(before);
    expect(Date.parse(after.scheduledRecoveryTime) > Date.parse(before)).toBe(delay === '2h');
});

test.each([429, 401, 500])('failure %s without explicit recovery preserves original cooldown', async status => {
    const { service, generate, manager } = setup();
    const before = JSON.stringify(manager._findProvider(type, 'one').config.antigravityQuotaHealth);
    generate.mockRejectedValue({ response: { status } }); await service.runOnce();
    expect(JSON.stringify(manager._findProvider(type, 'one').config.antigravityQuotaHealth)).toBe(before);
});

test('absolute recovery metadata is supported; invalid recovery is not invented', () => {
    const now = Date.now(), recovery = new Date(now + 900_000).toISOString();
    expect(getAntigravityExplicitRecoveryTime({ response: { data: { error: { details: [{ metadata: { quotaResetTimeStamp: recovery } }] } } } }, now)).toBe(recovery);
    expect(getAntigravityExplicitRecoveryTime({ response: { data: { error: { message: 'Quota exhausted' } } } }, now)).toBeNull();
});

test.each(['new429', 'disable', 'config', 'delete'])('probe cannot clear state changed while running: %s', async mutation => {
    const { service, generate, manager } = setup();
    generate.mockImplementation(async () => {
        const p = manager._findProvider(type, 'one');
        if (mutation === 'new429') manager.markAntigravityModelQuotaUnhealthy(type, p.config, model, 'new', Date.now() + 7200_000);
        if (mutation === 'disable') p.config.isDisabled = true;
        if (mutation === 'config') manager.providerConfigRevision++;
        if (mutation === 'delete') manager.providerStatus[type] = [];
        return answer();
    });
    await service.runOnce();
    const p = manager._findProvider(type, 'one');
    if (p) expect(p.config.antigravityQuotaHealth.models[model].isHealthy).toBe(false);
});

test('credential capacity is respected without queuing', async () => {
    const { manager, service, generate } = setup();
    manager._findProvider(type, 'one').state.activeCount = 1;
    await service.runOnce(); expect(generate).not.toHaveBeenCalled();
    expect(manager._findProvider(type, 'one').state.activeCount).toBe(1);
});

test('timeout aborts transport and releases capacity; stop drains active probes', async () => {
    jest.useFakeTimers();
    const { service, generate, manager } = setup();
    let aborted = false;
    generate.mockImplementation((m, body, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }));
    const running = service.runOnce();
    await jest.advanceTimersByTimeAsync(60_000); await running;
    expect(aborted).toBe(true); expect(manager._findProvider(type, 'one').state.activeCount).toBe(0);
    expect(manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model].isHealthy).toBe(false);
    service.runOnce(); await jest.advanceTimersByTimeAsync(0); await service.stop();
    expect(service.running).toBeNull();
});

test('healthy tombstone survives stale worker replay and restart; newer 429 wins', async () => {
    const { service, manager } = setup();
    const p = manager._findProvider(type, 'one').config;
    const old = structuredClone(p);
    await service.runOnce();
    const healthy = structuredClone(p);
    manager.syncAntigravityQuotaHealth(type, p, old.antigravityQuotaHealth);
    expect(p.antigravityQuotaHealth.models[model].isHealthy).toBe(true);
    applyProviderStateEvent({ [type]: [p] }, createProviderStateEvent(type, old));
    expect(p.antigravityQuotaHealth.models[model].isHealthy).toBe(true);
    const restarted = setup([JSON.parse(JSON.stringify(p))]);
    await restarted.service.runOnce(); expect(restarted.generate).not.toHaveBeenCalled();
    manager.markAntigravityModelQuotaUnhealthy(type, p, model, 'new', Date.now() + 7200_000);
    applyProviderStateEvent({ [type]: [p] }, createProviderStateEvent(type, healthy));
    expect(p.antigravityQuotaHealth.models[model].isHealthy).toBe(false);
});

test('two credentials at most run concurrently, with serial models within each account', async () => {
    const providers = ['a', 'b', 'c'].map(id => {
        const p = provider(id); p.antigravityQuotaHealth.models['gemini-3-flash'] = cool(); return p;
    });
    const { service, factory } = setup(providers);
    let active = 0, maximum = 0;
    const accounts = new Set(), calls = [];
    factory.mockImplementation(config => ({ probeCooldownModel: async target => {
        expect(accounts.has(config.uuid)).toBe(false);
        accounts.add(config.uuid); active++; maximum = Math.max(maximum, active);
        calls.push(`${config.uuid}/${target}`);
        await new Promise(resolve => setImmediate(resolve));
        accounts.delete(config.uuid); active--;
        return answer('43', target);
    } }));
    await service.runOnce();
    expect(maximum).toBe(2); expect(calls).toHaveLength(6); expect(new Set(calls).size).toBe(6);
});

test('Redis unavailable or occupied probe lock prevents generation', async () => {
    for (const acquire of [jest.fn().mockRejectedValue(new Error('offline')), jest.fn().mockResolvedValue(null)]) {
        const { service, generate } = setup(undefined, {}, { acquireProviderModelProbe: acquire });
        await service.runOnce(); expect(generate).not.toHaveBeenCalled();
    }
});

test('stale Redis version and failed Redis CAS never report recovery', async () => {
    const coordination = {
        acquireProviderModelProbe: jest.fn().mockResolvedValue('owner'),
        getProviderModelCooldown: jest.fn().mockResolvedValue({ value: '429', revision: JSON.stringify({ version: 'newer' }) }),
        releaseProviderModelProbe: jest.fn(), acquire: jest.fn().mockResolvedValue({ leaseId: 'lease' }),
        release: jest.fn(), compareProviderModelCooldown: jest.fn().mockResolvedValue(false)
    };
    const { service, manager, generate } = setup(undefined, {}, coordination);
    await service.runOnce(); expect(generate).not.toHaveBeenCalled();
    coordination.getProviderModelCooldown.mockResolvedValue({ value: '429', revision: '' });
    await service.runOnce(); expect(generate).toHaveBeenCalledTimes(1);
    expect(manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model].isHealthy).toBe(false);
    expect(coordination.release).toHaveBeenCalledWith('lease');
    expect(coordination.releaseProviderModelProbe).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls.some(([line]) => line.includes('"status":"recovered"'))).toBe(false);
});

test('failed persistence restores a retryable cooldown rather than claiming recovery', async () => {
    const { service, manager, generate } = setup();
    manager.persistenceEnabled = true;
    manager._flushPendingSaves = jest.fn().mockRejectedValue(new Error('disk unavailable'));
    await service.runOnce();
    expect(manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model]).toMatchObject({ isHealthy: false, source: 'cooldown_probe_rollback' });
    expect(log.info.mock.calls.some(([line]) => line.includes('"status":"recovered"'))).toBe(false);
    manager._flushPendingSaves.mockResolvedValue();
    await service.runOnce(); expect(generate).toHaveBeenCalledTimes(2);
    expect(manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model].isHealthy).toBe(true);
});

test('image cooldown schedules one image request with a 180 second deadline', async () => {
    const imageModel = 'gemini-3.1-flash-image';
    const { service, generate, manager } = setup([provider('image', { antigravityQuotaHealth: { models: { [imageModel]: cool() } } })]);
    generate.mockResolvedValue(answer('text only', imageModel));
    await service.runOnce();
    expect(generate).toHaveBeenCalledWith(imageModel, expect.objectContaining({ generationConfig: expect.objectContaining({ responseModalities: ['TEXT', 'IMAGE'] }) }), expect.objectContaining({ timeoutMs: 180_000 }));
    expect(manager._findProvider(type, 'image').config.antigravityQuotaHealth.models[imageModel].isHealthy).toBe(false);
});

test('configuration change during Redis CAS restores the current cooldown', async () => {
    let published;
    const coordination = {
        compareProviderModelCooldown: jest.fn(async (t, id, m, snapshot, next) => {
            published = next; manager.providerConfigRevision++; return true;
        }),
        getProviderModelCooldown: jest.fn(async () => ({ value: '', revision: JSON.stringify({ version: published.version }) }))
    };
    const { manager } = setup(undefined, {}, coordination);
    const [task] = manager.listAntigravityCooldownProbes();
    const result = await manager.applyAntigravityCooldownProbeResult(task, { success: true }, { value: 'old', revision: '' }, Date.now());
    expect(result).toBe(false);
    expect(coordination.compareProviderModelCooldown).toHaveBeenCalledTimes(2);
    expect(published).toMatchObject({ isHealthy: false, version: task.version });
    expect(manager._findProvider(type, 'one').config.antigravityQuotaHealth.models[model].isHealthy).toBe(false);
});

test('worker receives recovery after coalesced intermediate state and invalidates routing cache', () => {
    const { manager } = setup();
    const p = manager._findProvider(type, 'one').config;
    p.antigravityQuotaHealth.models[model] = { ...cool(), version: 'v1' };
    const eventConfig = structuredClone(p);
    eventConfig.antigravityQuotaHealth.models[model] = {
        isHealthy: true, version: 'recovered', supersedesVersion: 'v2', recoversVersion: 'v2', updatedAt: new Date().toISOString()
    };
    const before = manager._antigravityAvailabilityRevision;
    expect(manager.applyRemoteProviderState(createProviderStateEvent(type, eventConfig))).toBe(true);
    expect(p.antigravityQuotaHealth.models[model].isHealthy).toBe(true);
    expect(manager._antigravityAvailabilityRevision).toBeGreaterThan(before);
});
