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

import { autoLinkProviderConfigs } from '../src/services/service-manager.js';

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
});
