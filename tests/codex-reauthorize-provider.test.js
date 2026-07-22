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
    serviceInstances: {},
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/utils/file-lock.js', () => ({
    withFileLock: jest.fn(async (_filePath, operation) => operation()),
    atomicWriteFile: jest.fn()
}));

import { replaceProviderCredentialPath } from '../src/services/service-manager.js';
import { invalidateServiceAdapter } from '../src/providers/adapter.js';
import { atomicWriteFile } from '../src/utils/file-lock.js';

const originalCwd = process.cwd();
let tempDir;

beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-reauth-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'configs', 'codex'), { recursive: true });
    atomicWriteFile.mockImplementation((filePath, data, encoding) => fs.promises.writeFile(filePath, data, encoding));
});

afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Codex provider reauthorization', () => {
    test('replaces the credential path for the same provider while preserving routing config', async () => {
        const poolsPath = path.join(tempDir, 'configs', 'provider_pools.json');
        fs.writeFileSync(poolsPath, JSON.stringify({
            'openai-codex-oauth': [
                {
                    uuid: 'codex-1',
                    customName: 'primary@example.com',
                    CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/old.json',
                    PROXY_ID: 'proxy-existing',
                    providerWeight: 7,
                    concurrencyLimit: 3,
                    queueLimit: 11,
                    isHealthy: false,
                    errorCount: 5,
                    lastErrorTime: '2026-06-25T00:00:00.000Z'
                }
            ]
        }, null, 2));
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex', 'new.json'), JSON.stringify({
            account_id: 'account-new',
            email: 'primary@example.com',
            access_token: 'access',
            refresh_token: 'refresh'
        }, null, 2));

        const config = { PROVIDER_POOLS_FILE_PATH: poolsPath };

        const result = await replaceProviderCredentialPath(config, {
            providerType: 'openai-codex-oauth',
            providerUuid: 'codex-1',
            credPath: 'configs/codex/new.json'
        });

        const saved = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
        const provider = saved['openai-codex-oauth'][0];

        expect(result.updated).toBe(true);
        expect(provider.CODEX_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/').replace(/^\.\//, '')).toBe('configs/codex/new.json');
        expect(provider).toMatchObject({
            uuid: 'codex-1',
            customName: 'primary@example.com',
            codexAccountKey: 'account-new',
            codexAccountId: 'account-new',
            codexEmail: 'primary@example.com',
            PROXY_ID: 'proxy-existing',
            providerWeight: 7,
            concurrencyLimit: 3,
            queueLimit: 11,
            isHealthy: true,
            errorCount: 0,
            lastErrorTime: null
        });
    });

    test('updates the provider proxy only after successful reauthorization persistence', async () => {
        const poolsPath = path.join(tempDir, 'configs', 'provider_pools.json');
        fs.writeFileSync(poolsPath, JSON.stringify({
            'openai-codex-oauth': [{
                uuid: 'codex-1',
                CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/old.json',
                PROXY_ID: 'proxy-old',
                providerWeight: 7
            }]
        }, null, 2));
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex', 'new.json'), JSON.stringify({
            account_id: 'account-new',
            email: 'primary@example.com'
        }, null, 2));

        await replaceProviderCredentialPath({ PROVIDER_POOLS_FILE_PATH: poolsPath }, {
            providerType: 'openai-codex-oauth',
            providerUuid: 'codex-1',
            credPath: 'configs/codex/new.json',
            proxyId: 'proxy-new'
        });

        const saved = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
        expect(saved['openai-codex-oauth'][0]).toMatchObject({
            uuid: 'codex-1',
            PROXY_ID: 'proxy-new',
            providerWeight: 7
        });
        expect(invalidateServiceAdapter).toHaveBeenCalledWith('openai-codex-oauth', 'codex-1');
        expect(atomicWriteFile.mock.invocationCallOrder[0])
            .toBeLessThan(invalidateServiceAdapter.mock.invocationCallOrder[0]);
    });

    test('clears the provider proxy when reauthorization explicitly selects direct access', async () => {
        const poolsPath = path.join(tempDir, 'configs', 'provider_pools.json');
        fs.writeFileSync(poolsPath, JSON.stringify({
            'openai-codex-oauth': [{
                uuid: 'codex-1',
                CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/old.json',
                PROXY_ID: 'proxy-old',
                concurrencyLimit: 3
            }]
        }, null, 2));
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex', 'new.json'), JSON.stringify({
            account_id: 'account-new',
            email: 'primary@example.com'
        }, null, 2));

        await replaceProviderCredentialPath({ PROVIDER_POOLS_FILE_PATH: poolsPath }, {
            providerType: 'openai-codex-oauth',
            providerUuid: 'codex-1',
            credPath: 'configs/codex/new.json',
            proxyId: ''
        });

        const saved = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
        const provider = saved['openai-codex-oauth'][0];
        expect(provider.PROXY_ID).toBeUndefined();
        expect(provider.concurrencyLimit).toBe(3);
    });

    test('keeps disk and memory provider config unchanged when persistence fails', async () => {
        const poolsPath = path.join(tempDir, 'configs', 'provider_pools.json');
        const originalPools = {
            'openai-codex-oauth': [{
                uuid: 'codex-1',
                CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/old.json',
                PROXY_ID: 'proxy-old',
                providerWeight: 7,
                concurrencyLimit: 3
            }]
        };
        fs.writeFileSync(poolsPath, JSON.stringify(originalPools, null, 2));
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex', 'new.json'), JSON.stringify({
            account_id: 'account-new',
            email: 'primary@example.com'
        }, null, 2));
        const config = {
            PROVIDER_POOLS_FILE_PATH: poolsPath,
            providerPools: JSON.parse(JSON.stringify(originalPools))
        };
        atomicWriteFile.mockRejectedValueOnce(new Error('provider pool write failed'));

        await expect(replaceProviderCredentialPath(config, {
            providerType: 'openai-codex-oauth',
            providerUuid: 'codex-1',
            credPath: 'configs/codex/new.json',
            proxyId: 'proxy-new'
        })).rejects.toThrow('provider pool write failed');

        expect(JSON.parse(fs.readFileSync(poolsPath, 'utf8'))).toEqual(originalPools);
        expect(config.providerPools).toEqual(originalPools);
        expect(invalidateServiceAdapter).not.toHaveBeenCalled();
    });
});
