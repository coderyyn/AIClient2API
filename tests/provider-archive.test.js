import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { buildArchiveUpdate, assertRoutingNotArchived, withCredentialLifecycleLock } from '../src/utils/provider-archive.js';
import { getProviderUiAvailability } from '../src/utils/provider-ui-availability.js';
import { createProviderConfigEvent } from '../src/runtime/provider-config-event.js';
import { createProviderStateEvent } from '../src/runtime/provider-state-event.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { handleArchiveProviders, handleDisableEnableProvider, handleDeleteUnhealthyProviders,
    handleUpdateProvider, handleRefreshProviderToken } from '../src/ui-modules/provider-api.js';

jest.mock('sharp', () => ({ default: () => ({}) }));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(), getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
const mockBindings = jest.fn(() => []);
jest.mock('../src/plugins/api-potluck/key-manager.js', () => ({ getCredentialArchiveBindings: (...args) => mockBindings(...args) }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const type = 'openai-custom';
const original = [{ uuid: 'a', isHealthy: false, usageCount: 42 }, { uuid: 'b', isHealthy: true }];
let dir, file, config;
const managers = [];
function manager(pools) {
    const result = new ProviderPoolManager(pools, { persistenceEnabled: false, logLevel: 'error', globalConfig: config });
    managers.push(result);
    return result;
}
function request(body) {
    return { headers: {}, on(event, callback) {
        if (event === 'data') callback(Buffer.from(JSON.stringify(body)));
        if (event === 'end') callback();
        return this;
    }, resume() {}, destroy() {} };
}
function response() {
    return { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
}
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-archive-test-'));
    file = path.join(dir, 'pools.json');
    config = { PROVIDER_POOLS_FILE_PATH: file };
    fs.writeFileSync(file, JSON.stringify({ [type]: original }));
    mockBindings.mockReturnValue([]);
});
afterEach(() => {
    for (const item of managers.splice(0)) { clearTimeout(item.saveTimer); clearInterval(item._cleanupInterval); }
    fs.rmSync(dir, { recursive: true });
});

test('legacy config, archive idempotency, restore and historical identity', () => {
    expect(getProviderUiAvailability({})).toEqual({ uiAvailable: true, uiUnavailableReason: null });
    const archived = buildArchiveUpdate(original, ['a'], 'archive', [], '2026-10-14T00:00:00Z');
    expect(archived[0]).toMatchObject({ isArchived: true, isDisabled: true, usageCount: 42, uuid: 'a' });
    expect(getProviderUiAvailability(archived[0]).uiUnavailableReason).toBe('archived');
    expect(buildArchiveUpdate(archived, ['a'], 'archive')[0].archivedAt).toBe(archived[0].archivedAt);
    expect(buildArchiveUpdate(archived, ['a'], 'restore')[0]).toMatchObject({ isArchived: false, isDisabled: true, archivedAt: null, usageCount: 42 });
    expect(original[0].isArchived).toBeUndefined();
});

test('whole batch rejects missing or bound credentials without persisting or publishing', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const pool = { publishProviderConfig: jest.fn() };
    mockBindings.mockReturnValue([{ uuid: 'b', keyLabel: '测试 Key' }]);
    const res = response();
    await handleArchiveProviders(request({ uuids: ['a', 'b'] }), res, config, pool, type, 'archive');
    expect(res.status).toBe(409);
    expect(res.body.error.conflicts).toEqual([{ uuid: 'b', keyLabel: '测试 Key' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(pool.publishProviderConfig).not.toHaveBeenCalled();
    const missing = response();
    await handleArchiveProviders(request({ uuids: ['a', 'missing'] }), missing, config, pool, type, 'archive');
    expect(missing.status).toBe(404);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

test('archive persists, reloads, rejects enable/edit bypass and survives delete unhealthy', async () => {
    const pool = manager({ [type]: structuredClone(original) });
    const res = response();
    await handleArchiveProviders({}, res, config, pool, type, 'archive', 'a');
    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(file))[type][0].isArchived).toBe(true);
    const restarted = manager(JSON.parse(fs.readFileSync(file)));
    expect(restarted._findProvider(type, 'a').config.isDisabled).toBe(true);
    const enable = response();
    await handleDisableEnableProvider({}, enable, config, pool, type, 'a', 'enable');
    expect(enable.status).toBe(409);
    const edit = response();
    await handleUpdateProvider(request({ providerConfig: { isArchived: false, isDisabled: false, archivedAt: null } }), edit, config, pool, type, 'a');
    expect(edit.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(file))[type][0]).toMatchObject({ isArchived: true, isDisabled: true });
    const deleted = response();
    await handleDeleteUnhealthyProviders({}, deleted, config, pool, type);
    expect(JSON.parse(fs.readFileSync(file))[type].map(item => item.uuid)).toContain('a');
    const restore = response();
    await handleArchiveProviders({}, restore, config, pool, type, 'restore', 'a');
    expect(JSON.parse(fs.readFileSync(file))[type][0]).toMatchObject({ isArchived: false, isDisabled: true });
});

test('routing rejects archived fixed/restricted credentials and lifecycle queue serializes mutations', async () => {
    const pools = { [type]: [{ uuid: 'a', isArchived: true }] };
    expect(() => assertRoutingNotArchived({ routingMode: 'fixed', fixedCredential: { uuid: 'a', providerType: type } }, pools)).toThrow('已归档');
    expect(() => assertRoutingNotArchived({ routingMode: 'restricted', restrictedCredentialUuids: ['a', 'b'] }, pools)).toThrow('已归档');
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const events = [];
    const first = withCredentialLifecycleLock(async () => { events.push('archive'); await barrier; events.push('persisted'); });
    const next = withCredentialLifecycleLock(() => { events.push('binding'); expect(() => assertRoutingNotArchived({ routingMode: 'fixed', fixedCredential: { uuid: 'a' } }, pools)).toThrow(); });
    await Promise.resolve();
    expect(events).toEqual(['archive']);
    release();
    await Promise.all([first, next]);
    expect(events).toEqual(['archive', 'persisted', 'binding']);
});

test('config sync excludes routing and queued refresh, stale state cannot restore archived credential', async () => {
    const pool = manager({ [type]: [{ uuid: 'a', isHealthy: true }, { uuid: 'b', isHealthy: true }] });
    const old = pool._findProvider(type, 'a');
    const stale = createProviderStateEvent(type, { uuid: 'a', isHealthy: true, needsRefresh: false }, 0);
    pool.applyProviderConfigSync(createProviderConfigEvent(type,
        buildArchiveUpdate(pool.providerPools[type], ['a'], 'archive'), { revision: 1 }));
    expect(old.config.isArchived).toBe(true);
    expect(await pool._refreshNodeToken(type, old, true)).toBe(false);
    expect(await pool.refreshNode(type, 'a')).toBe(false);
    expect(pool.applyRemoteProviderState(stale)).toBe(false);
    expect((await pool.selectProvider(type)).uuid).toBe('b');
    const refresh = response();
    await handleRefreshProviderToken({}, refresh, config, pool, type, 'a');
    expect(refresh.status).toBe(409);
    pool.resetAllHealthInType(type);
    expect(pool._findProvider(type, 'a').config).toMatchObject({ isArchived: true, isDisabled: true });
});

test('UI categories and search exclude archived entries from normal all/available views', () => {
    const source = fs.readFileSync('static/app/modal.js', 'utf8');
    const start = source.indexOf('function getFilteredProviders()');
    const end = source.indexOf('function updateProviderAvailabilityControls', start);
    const context = { currentProviders: [
        { uuid: 'a', customName: 'old', uiAvailable: true, isArchived: true },
        { uuid: 'b', customName: 'new', uiAvailable: true },
        { uuid: 'c', customName: 'disabled', uiAvailable: false }
    ], currentArchiveFilter: 'active', currentAvailabilityFilter: 'all', nodeSearchTerm: '' };
    vm.runInNewContext(source.slice(start, end), context);
    expect(context.getFilteredProviders().map(p => p.uuid)).toEqual(['b', 'c']);
    context.currentAvailabilityFilter = 'available';
    expect(context.getFilteredProviders().map(p => p.uuid)).toEqual(['b']);
    context.currentArchiveFilter = 'archived';
    expect(context.getFilteredProviders().map(p => p.uuid)).toEqual(['a']);
    context.nodeSearchTerm = 'new';
    expect(context.getFilteredProviders()).toHaveLength(0);
});


test('a local request already queued when archived does not acquire the credential', async () => {
    const pool = manager({ [type]: [{ uuid: 'a', isHealthy: true, concurrencyLimit: 1, queueLimit: 2 }] });
    const selected = await pool.acquireSlot(type);
    expect(selected.uuid).toBe('a');
    const waiting = pool.acquireSlot(type, null, { queueTimeout: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(pool._findProvider(type, 'a').state.waitingCount).toBe(1);
    pool.publishProviderConfig(type, buildArchiveUpdate(pool.providerPools[type], ['a'], 'archive'));
    pool.releaseSlot(type, 'a');
    expect(await waiting).toBeNull();
    expect(pool._findProvider(type, 'a').state.activeCount).toBe(0);
});

test('cards only render the current page', () => {
    const source = fs.readFileSync('static/app/modal.js', 'utf8');
    const start = source.indexOf('function renderProviderListPaginated(');
    const end = source.indexOf('async function loadModelsForProviderType', start);
    const context = { currentViewMode: 'card', PROVIDERS_PER_PAGE: 5, renderProviderList: items => items, currentAvailabilityFilter: 'all' };
    vm.runInNewContext(source.slice(start, end), context);
    const entries = Array.from({ length: 12 }, (_, index) => ({ uuid: String(index) }));
    expect(context.renderProviderListPaginated(entries, 2).map(item => item.uuid)).toEqual(['5','6','7','8','9']);
});


test('pagination clears prior selections even when the next filter has no results', () => {
    const source = fs.readFileSync('static/app/modal.js', 'utf8');
    const start = source.indexOf('function goToProviderPage(');
    const end = source.indexOf('function renderProviderListPaginated', start);
    const selected = new Set(['previous-page']);
    const context = { selectedArchiveUuids: selected, getFilteredProviders: () => [], PROVIDERS_PER_PAGE: 5,
        document: { getElementById: () => null, querySelector: () => null }, currentPage: 3 };
    vm.runInNewContext(source.slice(start, end), context);
    context.goToProviderPage(1);
    expect(selected.size).toBe(0);
    expect(context.currentPage).toBe(1);
});
