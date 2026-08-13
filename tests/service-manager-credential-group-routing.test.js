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
    getApiService,
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';
import { codexCredentialGroupAffinityStore } from '../src/providers/openai/codex-credential-group-affinity.js';

const providerType = 'openai-codex-oauth';
let tempDir;
let groupFilePath;

function provider(uuid, overrides = {}) {
    return {
        uuid,
        customName: uuid,
        codexAccountKey: `account-${uuid}`,
        lastKnownCodexPlan: 'pro',
        supportedModels: ['gpt-5.4-mini'],
        ...overrides
    };
}

function writeGroupConfig({ groups, keyAssignments }) {
    fs.writeFileSync(groupFilePath, JSON.stringify({
        version: 1,
        currentRevision: 1,
        revisions: [{
            revision: 1,
            action: 'apply',
            previousRevision: null,
            config: { groups, keyAssignments }
        }]
    }), 'utf8');
}

function createConfig({
    providers = [provider('codex-a'), provider('codex-b')],
    keyData = {},
    sessionId = 'session-a',
    extra = {}
} = {}) {
    return {
        MODEL_PROVIDER: providerType,
        PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider-pools.json'),
        CODEX_CREDENTIAL_GROUPS_FILE_PATH: groupFilePath,
        CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
        potluckApiKey: 'maki_test_secret_not_persisted',
        potluckKeyData: {
            id: 'key-1',
            name: 'Key 1',
            routingMode: 'auto',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false,
            ...keyData
        },
        _codexCacheAffinityScope: sessionId ? { sessionId } : {},
        _codexOverloadFailoverKey: sessionId ? `session:${sessionId}` : null,
        providerPools: {
            [providerType]: providers
        },
        ...extra
    };
}

async function initialize(config) {
    await initApiService(config, false, { persistenceEnabled: false });
    return getProviderPoolManager();
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-credential-groups-'));
    groupFilePath = path.join(tempDir, 'codex-credential-groups.json');
    codexCredentialGroupAffinityStore.clearAll();
});

afterEach(() => {
    jest.restoreAllMocks();
    codexCredentialGroupAffinityStore.clearAll();
    const manager = getProviderPoolManager();
    if (manager?.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
    }
    manager?.pendingSaves?.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Service Manager Codex credential-group routing', () => {
    test('fixed routing constrains both service entry points to the specified credential', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: []
        });
        const config = createConfig({
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-b' },
                manualLock: true
            }
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const basicService = await getApiService(config, 'gpt-5.4-mini');
        const detailed = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(basicService.providerUuid).toBe('codex-b');
        expect(detailed.uuid).toBe('codex-b');
        expect(selectSpy).toHaveBeenCalledTimes(2);
        for (const call of selectSpy.mock.calls) {
            expect(call[2]).toMatchObject({
                allowedProviderUuids: ['codex-b'],
                disableProviderFallback: true
            });
        }
        expect(config._codexRouting).toMatchObject({
            routingMode: 'fixed',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b',
            spillover: false
        });
    });

    test.each([
        ['unhealthy', provider('codex-a', { isHealthy: false })],
        ['unsupported model', provider('codex-a', { supportedModels: ['gpt-5.3-codex'] })],
        ['concurrency exhausted', provider('codex-a', { concurrencyLimit: 1, queueLimit: 0 })]
    ])('fixed routing fails closed when the credential is %s', async (caseName, fixedProvider) => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a', 'codex-b'] }],
            keyAssignments: []
        });
        const config = createConfig({
            providers: [fixedProvider, provider('codex-b')],
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' },
                manualLock: true
            }
        });
        const manager = await initialize(config);
        if (caseName === 'concurrency exhausted') {
            manager.providerStatus[providerType][0].state.activeCount = 1;
        }

        const options = caseName === 'concurrency exhausted' ? { acquireSlot: true } : {};
        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini', options)).rejects.toMatchObject({
            code: 'FIXED_CREDENTIAL_UNAVAILABLE'
        });
        expect(config._codexRouting).toMatchObject({
            routingMode: 'fixed',
            selectedProviderUuid: null,
            spillover: false
        });
    });

    test('auto routing tries the primary group first and constrains each group attempt separately', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            providers: [provider('codex-a', { isHealthy: false }), provider('codex-b')]
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(result.uuid).toBe('codex-b');
        expect(selectSpy.mock.calls.map(call => call[2].allowedProviderUuids)).toEqual([
            ['codex-a'],
            ['codex-b']
        ]);
        expect(selectSpy.mock.calls.every(call => call[2].disableProviderFallback === true)).toBe(true);
        expect(config._codexRouting).toMatchObject({
            routingMode: 'auto',
            requestedPrimaryGroupId: 'group-a',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b',
            spillover: true,
            spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE'
        });
    });

    test('auto spillover stays on the selected group for the same session while a new session retries primary', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const firstConfig = createConfig({
            providers: [provider('codex-a', { isHealthy: false }), provider('codex-b')],
            sessionId: 'same-session'
        });
        const manager = await initialize(firstConfig);

        const first = await getApiServiceWithFallback(firstConfig, 'gpt-5.4-mini');
        expect(first.uuid).toBe('codex-b');

        manager.providerStatus[providerType].find(item => item.uuid === 'codex-a').config.isHealthy = true;
        const sameSessionConfig = createConfig({ sessionId: 'same-session' });
        sameSessionConfig.providerPools = firstConfig.providerPools;
        const sameSession = await getApiServiceWithFallback(sameSessionConfig, 'gpt-5.4-mini');
        expect(sameSession.uuid).toBe('codex-b');
        expect(sameSessionConfig._codexRouting).toMatchObject({
            selectedGroupId: 'group-b',
            spillover: true
        });

        const newSessionConfig = createConfig({ sessionId: 'new-session' });
        newSessionConfig.providerPools = firstConfig.providerPools;
        const newSession = await getApiServiceWithFallback(newSessionConfig, 'gpt-5.4-mini');
        expect(newSession.uuid).toBe('codex-a');
        expect(newSessionConfig._codexRouting).toMatchObject({
            selectedGroupId: 'group-a',
            spillover: false
        });

        const persisted = JSON.parse(fs.readFileSync(groupFilePath, 'utf8'));
        expect(persisted.revisions[0].config.keyAssignments[0].primaryGroupId).toBe('group-a');
    });

    test('an unassigned auto key preserves the legacy whole-pool routing behavior', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: []
        });
        const config = createConfig();
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(['codex-a', 'codex-b']).toContain(result.uuid);
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toBeUndefined();
        expect(config._codexRouting).toMatchObject({ assignmentMissing: true });
    });

    test('group routing never crosses into a configured provider fallback type', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            extra: {
                providerPools: {
                    [providerType]: [provider('codex-a', { isHealthy: false })],
                    'openai-custom': [{
                        uuid: 'openai-fallback',
                        customName: 'fallback',
                        supportedModels: ['gpt-5.4-mini']
                    }]
                },
                providerFallbackChain: {
                    [providerType]: ['openai-custom']
                }
            }
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toThrow('No healthy provider found');
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy.mock.calls[0]).toEqual(expect.arrayContaining([providerType, 'gpt-5.4-mini']));
        expect(selectSpy.mock.calls[0][2]).toMatchObject({ disableProviderFallback: true });
    });
});
