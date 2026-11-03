import { Readable } from 'node:stream';
import { handleGetConfig, handleUpdateConfig, reloadConfig } from '../src/ui-modules/config-api.js';
import { handleAddProvider, handleUpdateProvider } from '../src/ui-modules/provider-api.js';
import { CONFIG } from '../src/core/config-manager.js';
import { serviceInstances } from '../src/providers/adapter.js';
import { atomicWriteFile } from '../src/utils/file-lock.js';
import { resolveCodexImageHelperModel } from '../src/providers/openai/codex-image-helper.js';
import { applyCodexRuntimeConfigEvent, resetCodexRuntimeConfigSyncForTests } from '../src/runtime/codex-runtime-config-sync.js';

const mockFiles = new Map();
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: path => mockFiles.has(path),
        readFileSync: (path, ...args) => mockFiles.has(path) ? mockFiles.get(path) : actual.readFileSync(path, ...args),
        promises: {
            ...actual.promises,
            readFile: async path => {
                if (mockFiles.has(path)) return mockFiles.get(path);
                throw Object.assign(new Error('Missing test fixture'), { code: 'ENOENT' });
            }
        }
    };
});
jest.mock('../src/utils/file-lock.js', () => ({
    withFileLock: async (_path, fn) => fn(),
    atomicWriteFile: jest.fn(async (path, contents) => mockFiles.set(path, contents)),
    atomicWriteFileSync: jest.fn()
}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), initialize: jest.fn(), cleanupOldLogs: jest.fn() }
}));
jest.mock('../src/utils/proxy-pool-store.js', () => ({ assertCodexProxyBinding: jest.fn() }));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/ui-modules/auth.js', () => ({ validateCredentials: async () => false }));
jest.mock('../src/services/service-manager.js', () => ({ initApiService: jest.fn(), getProviderPoolManager: () => null }));
jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}, getRegisteredProviders: () => [], getServiceAdapter: jest.fn(), invalidateServiceAdapter: jest.fn()
}));

const providerType = 'openai-codex-oauth';
const configPath = 'configs/config.json';
const poolsPath = 'configs/provider_pools.json';
let previousConfig;
let previousRole;
let previousSend;

function request(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = {};
    return req;
}

function response() {
    return { writeHead: jest.fn(), end: jest.fn() };
}

function result(res) {
    return JSON.parse(res.end.mock.calls[0][0]);
}

beforeEach(() => {
    jest.clearAllMocks();
    previousConfig = { ...CONFIG };
    previousRole = process.env.RUNTIME_WORKER_ROLE;
    previousSend = process.send;
    delete process.env.RUNTIME_WORKER_ROLE;
    resetCodexRuntimeConfigSyncForTests();
    mockFiles.clear();
    mockFiles.set(configPath, JSON.stringify({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna' }));
    mockFiles.set(poolsPath, JSON.stringify({ [providerType]: [{ uuid: 'a', CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-terra' }] }));
    Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
});

afterEach(() => {
    Object.keys(CONFIG).forEach(key => delete CONFIG[key]);
    Object.assign(CONFIG, previousConfig);
    if (previousRole === undefined) delete process.env.RUNTIME_WORKER_ROLE;
    else process.env.RUNTIME_WORKER_ROLE = previousRole;
    process.send = previousSend;
});

test.each([123, true, {}, [], 'gpt-image-2', 'gpt-6.1-sol-fast', 'unknown', 'gpt-6****broken'])(
    'global and node management reject %p before saving or changing shared config', async value => {
        const config = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna', MAX_ERROR_COUNT: 10 };
        const before = [...mockFiles.entries()];
        const manager = { publishProviderConfig: jest.fn() };
        const globalRes = response();
        await handleUpdateConfig(request({ CODEX_IMAGE_HELPER_MODEL: value, MAX_ERROR_COUNT: 99 }), globalRes, config);
        expect(globalRes.writeHead.mock.calls[0][0]).toBe(400);
        expect(result(globalRes).error.code).toBe('invalid_image_helper_model');
        expect(config).toEqual({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna', MAX_ERROR_COUNT: 10 });
        for (const operation of ['add', 'update']) {
            const res = response();
            const req = request({ providerType, providerConfig: { uuid: 'a', CODEX_IMAGE_HELPER_MODEL: value } });
            if (operation === 'add') await handleAddProvider(req, res, {}, manager);
            else await handleUpdateProvider(req, res, {}, manager, providerType, 'a');
            expect(res.writeHead.mock.calls[0][0]).toBe(400);
            expect(result(res).error.code).toBe('invalid_image_helper_model');
        }
        expect(atomicWriteFile).not.toHaveBeenCalled();
        expect(manager.publishProviderConfig).not.toHaveBeenCalled();
        expect([...mockFiles.entries()]).toEqual(before);
    }
);

test('global save round-trips through GET and real configuration reload', async () => {
    const config = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna' };
    serviceInstances[`${providerType}a`] = { config: { ...config } };
    const unrelated = {};
    serviceInstances['openai-custom'] = unrelated;
    const res = response();
    await handleUpdateConfig(request({ CODEX_IMAGE_HELPER_MODEL: ' gpt-6.1-sol ' }), res, config);
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(JSON.parse(mockFiles.get(configPath)).CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-sol');
    expect(serviceInstances[`${providerType}a`]).toBeUndefined();
    expect(serviceInstances['openai-custom']).toBe(unrelated);
    const getRes = response();
    await handleGetConfig({}, getRes, config);
    expect(result(getRes).CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-sol');
    const loaded = await reloadConfig(null);
    expect(loaded.CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-sol');
    expect(resolveCodexImageHelperModel(loaded, loaded.providerPools[providerType][0])).toBe('gpt-6.1-terra');
});

test.each([null, '', '   '])('clearing node to %p persists inheritance and clearing global restores default', async value => {
    const config = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' };
    const manager = { publishProviderConfig: jest.fn() };
    const res = response();
    await handleUpdateProvider(request({ providerConfig: { CODEX_IMAGE_HELPER_MODEL: value } }), res, config, manager, providerType, 'a');
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    const node = JSON.parse(mockFiles.get(poolsPath))[providerType][0];
    expect(node.CODEX_IMAGE_HELPER_MODEL).toBe('');
    expect(manager.publishProviderConfig.mock.calls[0][1][0].CODEX_IMAGE_HELPER_MODEL).toBe('');
    expect(resolveCodexImageHelperModel(config, node)).toBe('gpt-6.1-sol');
    const globalRes = response();
    await handleUpdateConfig(request({ CODEX_IMAGE_HELPER_MODEL: value }), globalRes, config);
    expect(globalRes.writeHead.mock.calls[0][0]).toBe(200);
    expect(resolveCodexImageHelperModel(config, node)).toBe('gpt-6-luna');
});

test('adding a node normalizes its explicit helper and publishes it', async () => {
    const manager = { publishProviderConfig: jest.fn() };
    const res = response();
    await handleAddProvider(request({ providerType, providerConfig: { uuid: 'b', CODEX_IMAGE_HELPER_MODEL: ' gpt-6-astra ' } }), res, {}, manager);
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(JSON.parse(mockFiles.get(poolsPath))[providerType][1].CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6-astra');
    expect(manager.publishProviderConfig.mock.calls[0][1][1].CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6-astra');
});

test('save failure retains the previous helper and cached adapter', async () => {
    const config = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna' };
    const adapter = {};
    serviceInstances[`${providerType}a`] = adapter;
    atomicWriteFile.mockRejectedValueOnce(new Error('test write failure'));
    const res = response();
    await handleUpdateConfig(request({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' }), res, config);
    expect(res.writeHead.mock.calls[0][0]).toBe(500);
    expect(config.CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6-luna');
    expect(serviceInstances[`${providerType}a`]).toBe(adapter);
    expect(JSON.parse(mockFiles.get(configPath)).CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6-luna');
});

test('an unrelated update retains the helper and adapter', async () => {
    const config = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' };
    const adapter = {};
    serviceInstances[`${providerType}a`] = adapter;
    const res = response();
    await handleUpdateConfig(request({ MAX_ERROR_COUNT: 8 }), res, config);
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(config.CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-sol');
    expect(JSON.parse(mockFiles.get(configPath)).CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-sol');
    expect(serviceInstances[`${providerType}a`]).toBe(adapter);
});

test('control save publishes a revisioned event which updates execution config and invalidates its adapter', async () => {
    process.env.RUNTIME_WORKER_ROLE = 'control';
    process.send = jest.fn();
    const config = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna' };
    const res = response();
    await handleUpdateConfig(request({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-terra' }), res, config);
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    const event = process.send.mock.calls[0][0];
    expect(event.config.CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-terra');
    const workerConfig = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-luna' };
    const workerInstances = { [`${providerType}a`]: {} };
    expect(applyCodexRuntimeConfigEvent(event, workerConfig, workerInstances).invalidated).toBe(1);
    expect(workerConfig.CODEX_IMAGE_HELPER_MODEL).toBe('gpt-6.1-terra');
});
