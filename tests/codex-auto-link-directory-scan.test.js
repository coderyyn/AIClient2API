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
    getServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import {
    autoLinkProviderConfigs,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';

const originalCwd = process.cwd();
let tempDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-autolink-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'configs', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'configs', 'codex', 'codex-account.json'), JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'account-1',
        email: 'user@example.com'
    }, null, 2));
});

afterEach(() => {
    const providerPoolManager = getProviderPoolManager();
    if (providerPoolManager?.saveTimer) {
        clearTimeout(providerPoolManager.saveTimer);
        providerPoolManager.saveTimer = null;
    }
    providerPoolManager?.pendingSaves?.clear();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Codex auto-link config scan', () => {
    test('links Codex credential files with the saved email as the display name', async () => {
        const config = { providerPools: {} };

        await autoLinkProviderConfigs(config);

        expect(config.providerPools['openai-codex-oauth']).toHaveLength(1);
        expect(config.providerPools['openai-codex-oauth'][0].customName).toBe('user@example.com');
        expect(fs.existsSync(path.join(tempDir, 'configs', 'provider_pools.json'))).toBe(true);
    });

    test('applies selected proxy defaults when linking the current Codex credential', async () => {
        const config = { providerPools: {} };
        const credPath = path.join(tempDir, 'configs', 'codex', 'codex-account.json');

        await autoLinkProviderConfigs(config, {
            onlyCurrentCred: true,
            credPath,
            providerDefaults: {
                PROXY_ID: 'pool-47-77-230-19'
            }
        });

        expect(config.providerPools['openai-codex-oauth']).toHaveLength(1);
        expect(config.providerPools['openai-codex-oauth'][0]).toMatchObject({
            customName: 'user@example.com',
            PROXY_ID: 'pool-47-77-230-19'
        });
    });

    test('updates existing Codex provider when a new credential has the same account identity', async () => {
        const oldCredPath = path.join(tempDir, 'configs', 'codex', 'old-account.json');
        const newCredPath = path.join(tempDir, 'configs', 'codex', 'new-account.json');
        fs.writeFileSync(oldCredPath, JSON.stringify({
            access_token: 'old-access-token',
            refresh_token: 'old-refresh-token',
            account_id: 'same-account-id',
            email: 'user@example.com'
        }, null, 2));
        fs.writeFileSync(newCredPath, JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            account_id: 'same-account-id',
            email: 'user@example.com'
        }, null, 2));

        const config = {
            providerPools: {
                'openai-codex-oauth': [{
                    uuid: 'existing-provider',
                    customName: 'user@example.com',
                    codexAccountKey: 'same-account-id',
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/old-account.json',
                    isHealthy: false,
                    needsRefresh: true,
                    errorCount: 3,
                    lastErrorMessage: 'expired'
                }]
            }
        };

        await autoLinkProviderConfigs(config, {
            onlyCurrentCred: true,
            credPath: newCredPath
        });

        expect(config.providerPools['openai-codex-oauth']).toHaveLength(1);
        expect(config.providerPools['openai-codex-oauth'][0]).toMatchObject({
            uuid: 'existing-provider',
            customName: 'user@example.com',
            codexAccountKey: 'same-account-id',
            codexEmail: 'user@example.com',
            isHealthy: true,
            needsRefresh: false,
            errorCount: 0,
            lastErrorMessage: null
        });
        expect(config.providerPools['openai-codex-oauth'][0].CODEX_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/'))
            .toBe('./configs/codex/new-account.json');
    });

    test('full directory scans do not recreate a provider from an old credential with the same identity', async () => {
        const activeCredPath = path.join(tempDir, 'configs', 'codex', 'active-account.json');
        const oldCredPath = path.join(tempDir, 'configs', 'codex', 'old-account.json');
        fs.writeFileSync(activeCredPath, JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            account_id: 'account-1',
            email: 'user@example.com'
        }, null, 2));
        fs.writeFileSync(oldCredPath, JSON.stringify({
            access_token: 'old-access-token',
            refresh_token: 'old-refresh-token',
            account_id: 'account-1',
            email: 'user@example.com'
        }, null, 2));

        const config = {
            providerPools: {
                'openai-codex-oauth': [{
                    uuid: 'existing-provider',
                    customName: 'user@example.com',
                    codexAccountKey: 'account-1',
                    codexAccountId: 'account-1',
                    codexEmail: 'user@example.com',
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/active-account.json'
                }]
            }
        };

        await autoLinkProviderConfigs(config);

        expect(config.providerPools['openai-codex-oauth']).toHaveLength(1);
        expect(config.providerPools['openai-codex-oauth'][0].uuid).toBe('existing-provider');
    });

    test('strict current-credential linking rolls back memory and rejects disk persistence failures', async () => {
        const credPath = path.join(tempDir, 'configs', 'codex', 'codex-account.json');
        const config = {
            providerPools: {},
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'configs')
        };

        await expect(autoLinkProviderConfigs(config, {
            onlyCurrentCred: true,
            credPath,
            throwOnPersistError: true
        })).rejects.toBeDefined();

        expect(config.providerPools).toEqual({});
    });

    test('strict persistence rollback also restores the initialized provider manager reference', async () => {
        const oldCredPath = path.join(tempDir, 'configs', 'codex', 'old-account.json');
        const newCredPath = path.join(tempDir, 'configs', 'codex', 'new-account.json');
        fs.writeFileSync(oldCredPath, JSON.stringify({
            account_id: 'same-account-id',
            email: 'user@example.com'
        }, null, 2));
        fs.writeFileSync(newCredPath, JSON.stringify({
            account_id: 'same-account-id',
            email: 'user@example.com'
        }, null, 2));
        const originalPools = {
            'openai-codex-oauth': [{
                uuid: 'existing-provider',
                customName: 'user@example.com',
                codexAccountKey: 'same-account-id',
                CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/old-account.json'
            }]
        };
        const config = {
            providerPools: JSON.parse(JSON.stringify(originalPools)),
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'configs')
        };
        await initApiService(config);
        const baselinePools = JSON.parse(JSON.stringify(config.providerPools));

        await expect(autoLinkProviderConfigs(config, {
            onlyCurrentCred: true,
            credPath: newCredPath,
            throwOnPersistError: true
        })).rejects.toBeDefined();

        expect(config.providerPools).toEqual(baselinePools);
        expect(getProviderPoolManager().providerPools).toEqual(baselinePools);
    });
});
