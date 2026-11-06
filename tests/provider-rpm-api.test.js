import { Readable } from 'node:stream';
import { handleAddProvider, handleUpdateProvider, handleGetProviderType } from '../src/ui-modules/provider-api.js';
import { atomicWriteFile } from '../src/utils/file-lock.js';
jest.mock('../src/utils/file-lock.js', () => ({
    withFileLock: async (_path, fn) => fn(), atomicWriteFile: jest.fn(), atomicWriteFileSync: jest.fn()
}));
jest.mock('fs', () => ({ ...jest.requireActual('fs'),
    existsSync: jest.fn(() => true),
    readFileSync: jest.fn(() => JSON.stringify({ 'openai-codex-oauth': [{ uuid: 'a', rpmLimit: 0 }] }))
}));
jest.mock('../src/utils/proxy-pool-store.js', () => ({ assertCodexProxyBinding: jest.fn() }));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: () => [], getServiceAdapter: jest.fn(), invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));
function request(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = {}; return req;
}
function response() {
    return { writeHead: jest.fn(), end: jest.fn() };
}
afterEach(() => jest.clearAllMocks());
test.each([-1, 1.5, 'invalid', null, true])('create and edit reject invalid RPM %p before saving', async rpmLimit => {
    for (const action of ['add', 'update']) {
        const res = response();
        const req = request({ providerType: 'openai-codex-oauth', providerConfig: { uuid: 'a', rpmLimit } });
        if (action === 'add') await handleAddProvider(req, res, {}, null);
        else await handleUpdateProvider(req, res, {}, null, 'openai-codex-oauth', 'a');
        expect(res.writeHead.mock.calls[0][0]).toBe(400);
        expect(res.end.mock.calls[0][0]).toContain('INVALID_PROVIDER_RPM_LIMIT');
    }
    expect(atomicWriteFile).not.toHaveBeenCalled();
});
test('edit persists integer RPM and publishes the canonical configuration', async () => {
    const manager = { publishProviderConfig: jest.fn() };
    const res = response();
    await handleUpdateProvider(request({ providerConfig: { rpmLimit: 180 } }), res, {}, manager, 'openai-codex-oauth', 'a');
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(JSON.parse(atomicWriteFile.mock.calls[0][1])['openai-codex-oauth'][0].rpmLimit).toBe(180);
    expect(manager.publishProviderConfig.mock.calls[0][1][0].rpmLimit).toBe(180);
});
test('provider detail exposes independent live RPM status', async () => {
    const manager = { providerPools: { 'openai-codex-oauth': [{ uuid: 'a', rpmLimit: 180 }] },
        coordination: { _eval: async () => ({ allowed: false, limit: 180, used: 180, retryAfterMs: 5000, nextAvailableAt: 10000 }) } };
    const res = response();
    await handleGetProviderType({}, res, {}, manager, 'openai-codex-oauth');
    expect(JSON.parse(res.end.mock.calls[0][0]).providers[0].rpm).toMatchObject({ limit: 180, used: 180, nextAvailableAt: 10000 });
});

test('new Codex credentials default to Luna-only and edits publish the explicit flag', async () => {
    const manager = { publishProviderConfig: jest.fn() };
    await handleAddProvider(request({ providerType: 'openai-codex-oauth', providerConfig: { uuid: 'new' } }), response(), {}, manager);
    expect(JSON.parse(atomicWriteFile.mock.calls[0][1])['openai-codex-oauth'].find(p => p.uuid === 'new').codexAllowNonLuna).toBe(false);
    atomicWriteFile.mockClear();
    await handleUpdateProvider(request({ providerConfig: { codexAllowNonLuna: true } }), response(), {}, manager, 'openai-codex-oauth', 'a');
    expect(manager.publishProviderConfig.mock.calls.at(-1)[1][0].codexAllowNonLuna).toBe(true);
});

test.each(['false', null, 0])('create and edit reject non-boolean Codex participation %p', async codexAllowNonLuna => {
    for (const action of [handleAddProvider, handleUpdateProvider]) {
        const res = response();
        await action(request({ providerType: 'openai-codex-oauth', providerConfig: { uuid: 'a', codexAllowNonLuna } }), res, {}, null, 'openai-codex-oauth', 'a');
        expect(res.writeHead.mock.calls[0][0]).toBe(400);
        expect(res.end.mock.calls[0][0]).toContain('INVALID_CODEX_MIXED_ROUTING');
    }
    expect(atomicWriteFile).not.toHaveBeenCalled();
});
