import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
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

import { autoLinkProviderConfigs, replaceProviderCredentialPath } from '../src/services/service-manager.js';
import { atomicWriteFile } from '../src/utils/file-lock.js';

let tempDir;
const originalCwd = process.cwd();

function makeWorkspace() {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-gemini-name-${Date.now()}-`), { recursive: true });
    process.chdir(tempDir);
    mkdirSync(join(tempDir, 'configs', 'antigravity'), { recursive: true });
    const poolsPath = join(tempDir, 'configs', 'provider_pools.json');
    return { poolsPath };
}

function writeCredential(name, credentials) {
    const filePath = join(tempDir, 'configs', 'antigravity', name);
    writeFileSync(filePath, JSON.stringify(credentials), 'utf8');
    return filePath;
}

function readPools(poolsPath) {
    return JSON.parse(readFileSync(poolsPath, 'utf8'));
}

beforeEach(() => {
    jest.clearAllMocks();
    atomicWriteFile.mockImplementation((filePath, data, encoding) =>
        import('fs').then(({ promises }) => promises.writeFile(filePath, data, encoding))
    );
});

afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
});

describe('Gemini account name persistence', () => {
    test('new providers use the account email as the default custom name', async () => {
        const { poolsPath } = makeWorkspace();
        const credPath = writeCredential('new_oauth_creds.json', { email: 'new.user@example.com' });
        const config = {
            PROVIDER_POOLS_FILE_PATH: poolsPath,
            providerPools: {}
        };

        await autoLinkProviderConfigs(config, {
            onlyCurrentCred: true,
            credPath,
            providerDefaults: {
                PROXY_ID: 'proxy-selected',
                accountEmail: 'new.user@example.com',
                customName: 'new.user@example.com'
            },
            throwOnPersistError: true
        });

        expect(readPools(poolsPath)['gemini-antigravity'][0]).toMatchObject({
            accountEmail: 'new.user@example.com',
            customName: 'new.user@example.com',
            PROXY_ID: 'proxy-selected'
        });
    });

    test('reauthorization updates accountEmail without replacing a custom label', async () => {
        const { poolsPath } = makeWorkspace();
        const credPath = writeCredential('replacement.json', { email: 'new.user@example.com' });
        writeFileSync(poolsPath, JSON.stringify({
            'gemini-antigravity': [{
                uuid: 'gemini-1',
                customName: 'My Gemini',
                accountEmail: 'old.user@example.com',
                providerWeight: 9,
                ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: './configs/antigravity/old.json'
            }]
        }), 'utf8');

        await replaceProviderCredentialPath({ PROVIDER_POOLS_FILE_PATH: poolsPath }, {
            providerType: 'gemini-antigravity',
            providerUuid: 'gemini-1',
            credPath,
            accountEmail: 'new.user@example.com'
        });

        expect(readPools(poolsPath)['gemini-antigravity'][0]).toMatchObject({
            customName: 'My Gemini',
            accountEmail: 'new.user@example.com',
            providerWeight: 9
        });
    });

    test('reauthorization fills an empty custom name from the account email', async () => {
        const { poolsPath } = makeWorkspace();
        const credPath = writeCredential('replacement.json', { email: 'filled@example.com' });
        writeFileSync(poolsPath, JSON.stringify({
            'gemini-antigravity': [{
                uuid: 'gemini-1',
                customName: '',
                ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: './configs/antigravity/old.json'
            }]
        }), 'utf8');

        await replaceProviderCredentialPath({ PROVIDER_POOLS_FILE_PATH: poolsPath }, {
            providerType: 'gemini-antigravity',
            providerUuid: 'gemini-1',
            credPath,
            accountEmail: 'filled@example.com'
        });

        expect(readPools(poolsPath)['gemini-antigravity'][0]).toMatchObject({
            customName: 'filled@example.com',
            accountEmail: 'filled@example.com'
        });
    });

    test('directory scans backfill empty Gemini names from legacy id tokens', async () => {
        const { poolsPath } = makeWorkspace();
        const payload = Buffer.from(JSON.stringify({ email: 'legacy@example.com', email_verified: true })).toString('base64url');
        writeCredential('legacy.json', { id_token: `header.${payload}.signature` });
        const pools = {
            'gemini-antigravity': [{
                uuid: 'gemini-legacy',
                customName: '',
                ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: './configs/antigravity/legacy.json'
            }]
        };
        writeFileSync(poolsPath, JSON.stringify(pools), 'utf8');
        const config = { PROVIDER_POOLS_FILE_PATH: poolsPath, providerPools: pools };

        await autoLinkProviderConfigs(config);

        expect(readPools(poolsPath)['gemini-antigravity'][0]).toMatchObject({
            customName: 'legacy@example.com',
            accountEmail: 'legacy@example.com'
        });
    });
});
