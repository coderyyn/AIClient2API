import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import requestContext from '../src/utils/context.js';
import { getServiceAdapter } from '../src/providers/adapter.js';
import { initApiService, getProviderPoolManager, getApiServiceWithFallback } from '../src/services/service-manager.js';
import { prepareMixedRequest, MIXED_CODEX, MIXED_KEY } from '../src/services/gpt-mixed-routing.js';
import { closeProviderLeaseScope } from '../src/runtime/provider-lease-scope.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ generateContent: async () => ({ object: 'response', id: 'fixture-response', model: 'gpt-6-sol' }) })),
    getRegisteredProviders: () => ['openai-codex-oauth', 'openaiResponses-custom'],
    invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));

let directory;
let config;
let manager;
const model = 'gpt-6-sol';

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-mixed-entry-'));
    config = {
        MODEL_PROVIDER: MIXED_CODEX, GPT_MIXED_ROUTING_ENABLED: true,
        PROVIDER_POOLS_FILE_PATH: path.join(directory, 'providers.json'),
        potluckKeyData: { id: 'fixture-client', routingMode: 'pool' },
        providerPools: {
            [MIXED_CODEX]: [{ uuid: 'same-id', codexAccountKey: 'fixture-codex', codexEmail: 'codex@example.invalid', lastKnownCodexPlan: 'pro', isHealthy: true }],
            [MIXED_KEY]: [{ uuid: 'same-id', customName: 'key@example.invalid', isHealthy: true, supportedModels: [model] }]
        }
    };
    await initApiService(config, false, { persistenceEnabled: false });
    manager = getProviderPoolManager();
    manager.coordination = {
        acquire: jest.fn(async candidates => ({ ...candidates[0], leaseId: 'fixture-' + candidates[0].providerType })),
        release: jest.fn(async () => true),
        getMixedResponseBinding: jest.fn(async () => null),
        setMixedResponseBinding: jest.fn(async () => {})
    };
    getServiceAdapter.mockClear();
});

afterEach(() => {
    clearTimeout(manager?.saveTimer);
    manager?.pendingSaves?.clear();
    jest.clearAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
});

test('normal selection constructs the actual adapter and retries across types without identity leakage or lease leakage', async () => {
    const store = {};
    await requestContext.run(store, async () => {
        prepareMixedRequest(config, model, {}, '/v1/responses');
        const first = await getApiServiceWithFallback(config, model, { acquireSlot: true });
        expect(first.actualProviderType).toBe(MIXED_CODEX);
        const second = await getApiServiceWithFallback(config, model, { acquireSlot: true, excludeProviderUuids: ['same-id'] });
        expect(second.actualProviderType).toBe(MIXED_KEY);
        expect(second.serviceConfig.codexEmail).toBeUndefined();
        expect(config._codexRouteResult.accountEmail).toBeNull();
        expect(getServiceAdapter.mock.calls.at(-1)[0].MODEL_PROVIDER).toBe(MIXED_KEY);
        await second.service.generateContent(model, {});
        expect(manager.coordination.setMixedResponseBinding).toHaveBeenCalledWith(expect.any(String), 'fixture-response', {
            providerType: MIXED_KEY, uuid: 'same-id', model
        });
        await closeProviderLeaseScope(store);
        expect(manager.coordination.release).toHaveBeenCalledTimes(2);
    });
});

test('adapter construction failure rolls back its provider lease', async () => {
    await requestContext.run({}, async () => {
        prepareMixedRequest(config, model, {}, '/v1/chat/completions');
        getServiceAdapter.mockImplementationOnce(() => { throw new Error('fixture adapter failure'); });
        await expect(getApiServiceWithFallback(config, model, { acquireSlot: true })).rejects.toThrow('fixture adapter failure');
        expect(manager.coordination.release).toHaveBeenCalledTimes(1);
    });
});

test('an exhausted Codex pool still permits an eligible Key credential', async () => {
    await requestContext.run({}, async () => {
        prepareMixedRequest(config, model, {}, '/v1/responses');
        const filter = manager._getHealthyProvidersForType.bind(manager);
        jest.spyOn(manager, '_getHealthyProvidersForType').mockImplementation((type, ...args) => {
            if (type === MIXED_CODEX) throw Object.assign(new Error('fixture quota exhausted'), { status: 429, filterReasons: { quota: 1 } });
            return filter(type, ...args);
        });
        const selected = await getApiServiceWithFallback(config, model, { acquireSlot: true });
        expect(selected.actualProviderType).toBe(MIXED_KEY);
        await closeProviderLeaseScope(requestContext.getStore());
        jest.restoreAllMocks();
    });
});

test('affinity is evaluated before mixed selection and blocks custom when OAuth is exhausted',async()=>{
 config.potluckApiKey='fixture';config.CODEX_POTLUCK_STICKY_PROVIDER_ENABLED=true;config._codexCacheAffinityScope={threadId:'fixture-thread'};
 await requestContext.run({},async()=>{
  prepareMixedRequest(config,model,{},'/v1/responses');
  const first=await getApiServiceWithFallback(config,model,{acquireSlot:true});expect(first.actualProviderType).toBe(MIXED_CODEX);
  await closeProviderLeaseScope(requestContext.getStore());
  manager.providerStatus[MIXED_CODEX][0].config.isDisabled=true;
  await expect(getApiServiceWithFallback(config,model,{acquireSlot:true})).rejects.toBeDefined();
  expect(getServiceAdapter.mock.calls.every(([c])=>c.MODEL_PROVIDER===MIXED_CODEX)).toBe(true);
 });
});
