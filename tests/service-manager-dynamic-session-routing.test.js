import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ providerUuid: config.uuid })),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth', 'openai-custom']),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import {
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';

const providerType = 'openai-codex-oauth';
const MODEL = 'gpt-6-sol';
let tempDir;

function provider(uuid, overrides = {}) {
    return {
        uuid,
        customName: uuid,
        codexAccountKey: `account-${uuid}`,
        lastKnownCodexPlan: 'pro',
        supportedModels: ['gpt-6-sol', 'gpt-6-luna'],
        ...overrides
    };
}

function allProviders() {
    return ['codex-a', 'codex-b', 'codex-c', 'codex-d'].map(uuid => provider(uuid));
}

function createConfig({
    providers = allProviders(),
    keyId = 'key-1',
    keyData = {},
    sessionId = 'session-a'
} = {}) {
    return {
        MODEL_PROVIDER: providerType,
        PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider-pools.json'),
        CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
        potluckApiKey: 'maki_test_secret_not_persisted',
        potluckKeyData: {
            id: keyId,
            name: keyId,
            routingMode: 'pool',
            fixedCredential: null,
            manualLock: false,
            ...keyData
        },
        _codexCacheAffinityScope: sessionId ? { sessionId } : {},
        _codexOverloadFailoverKey: sessionId ? `session:${sessionId}` : null,
        providerPools: { [providerType]: providers }
    };
}

async function initialize(config) {
    await initApiService(config, false, { persistenceEnabled: false });
    return getProviderPoolManager();
}

// A follow-up request that shares the provider pool (and so health/load state) with `base`.
function nextRequest(base, sessionId) {
    return createConfig({
        providers: base.providerPools[providerType],
        keyId: base.potluckKeyData.id,
        keyData: base.potluckKeyData,
        sessionId
    });
}

function setHealthy(manager, uuid, isHealthy) {
    manager.providerStatus[providerType].find(p => p.uuid === uuid).config.isHealthy = isHealthy;
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-key-routing-'));
});

afterEach(() => {
    jest.restoreAllMocks();
    const manager = getProviderPoolManager();
    if (manager?.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
    }
    manager?.pendingSaves?.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Codex key routing without credential groups', () => {
    describe('routing modes', () => {
        test.each([
            ['pool', { routingMode: 'pool' }],
            ['legacy auto with a primary group', { routingMode: 'auto', primaryGroupId: 'group-a' }],
            ['missing routing fields', { routingMode: undefined }]
        ])('%s uses the whole pool with a session sticky key', async (_label, keyData) => {
            const config = createConfig({ keyData });
            const manager = await initialize(config);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

            await getApiServiceWithFallback(config, MODEL);

            expect(selectSpy).toHaveBeenCalledTimes(1);
            const options = selectSpy.mock.calls[0][2];
            expect(options.allowedProviderUuids).toBeUndefined();
            expect(options.stickyProviderKey).toEqual(expect.any(String));
            expect(config._codexRouting).toMatchObject({
                routingMode: 'pool',
                selectedGroupId: null,
                affinitySource: 'session_id'
            });
        });

        test('fixed keys use their credential without needing a group', async () => {
            const fixedCredential = { providerType, uuid: 'codex-c' };
            const config = createConfig({ keyData: { routingMode: 'fixed', fixedCredential } });
            await initialize(config);

            const result = await getApiServiceWithFallback(config, MODEL);

            expect(result.uuid).toBe('codex-c');
            expect(config._codexRouting.routingMode).toBe('fixed');
        });

        test('restricted keys stay inside their credential set', async () => {
            const restrictedCredentialUuids = ['codex-c', 'codex-d'];
            const config = createConfig({ keyData: { routingMode: 'restricted', restrictedCredentialUuids } });
            await initialize(config);

            for (let i = 0; i < 8; i += 1) {
                const result = await getApiServiceWithFallback(nextRequest(config, `r-${i}`), MODEL);
                expect(restrictedCredentialUuids).toContain(result.uuid);
            }
        });
    });

    describe('candidate set and diagnostics', () => {
        test('can pick any healthy credential when one is unhealthy', async () => {
            const config = createConfig();
            const manager = await initialize(config);
            setHealthy(manager, 'codex-a', false);

            const result = await getApiServiceWithFallback(config, MODEL);

            expect(['codex-b', 'codex-c', 'codex-d']).toContain(result.uuid);
            expect(config._codexRouting).toMatchObject({
                selectedGroupId: null,
                selectedProviderUuid: result.uuid
            });
            expect(config._codexRouteResult).toMatchObject({
                selectedProviderUuid: result.uuid,
                providerSwitchCount: 0,
                consistencyStatus: 'consistent'
            });
        });

        test('honours the credential-level notSupportedModels exclusion', async () => {
            const providers = allProviders().map(p =>
                p.uuid === 'codex-b' ? { ...p, notSupportedModels: [MODEL] } : p);
            const config = createConfig({ providers });
            await initialize(config);

            const seen = new Set();
            for (let i = 0; i < 12; i += 1) {
                seen.add((await getApiServiceWithFallback(nextRequest(config, `s-${i}`), MODEL)).uuid);
            }

            expect(seen.has('codex-b')).toBe(false);
        });
    });

    describe('session stickiness and spreading', () => {
        test('keeps one session on one credential across requests', async () => {
            const base = createConfig({ sessionId: 'long-session' });
            await initialize(base);

            const picked = [];
            for (let i = 0; i < 6; i += 1) {
                picked.push((await getApiServiceWithFallback(nextRequest(base, 'long-session'), MODEL)).uuid);
            }

            expect(new Set(picked).size).toBe(1);
        });

        test('spreads distinct new sessions over every healthy credential', async () => {
            const base = createConfig();
            await initialize(base);

            const counts = {};
            for (let i = 0; i < 24; i += 1) {
                const res = await getApiServiceWithFallback(nextRequest(base, `new-session-${i}`), MODEL);
                counts[res.uuid] = (counts[res.uuid] || 0) + 1;
            }

            expect(Object.keys(counts).sort()).toEqual(['codex-a', 'codex-b', 'codex-c', 'codex-d']);
            expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(12);
        });

        test('moves a session to another credential once its bound credential is unhealthy', async () => {
            const base = createConfig({ sessionId: 'sticky-failover' });
            const manager = await initialize(base);

            const first = await getApiServiceWithFallback(nextRequest(base, 'sticky-failover'), MODEL);
            setHealthy(manager, first.uuid, false);
            const second = await getApiServiceWithFallback(nextRequest(base, 'sticky-failover'), MODEL);

            expect(second.uuid).not.toBe(first.uuid);
        });

        test('never routes to unhealthy credentials', async () => {
            const base = createConfig();
            const manager = await initialize(base);
            setHealthy(manager, 'codex-a', false);
            setHealthy(manager, 'codex-b', false);

            const seen = new Set();
            for (let i = 0; i < 10; i += 1) {
                seen.add((await getApiServiceWithFallback(nextRequest(base, `h-${i}`), MODEL)).uuid);
            }

            expect([...seen].sort()).toEqual(['codex-c', 'codex-d']);
        });
    });
});
