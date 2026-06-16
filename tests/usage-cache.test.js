import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadUsageCacheModule() {
    jest.resetModules();
    return await import('../src/ui-modules/usage-cache.js');
}

function writeCache(data) {
    const configsDir = path.join(tempDir, 'configs');
    fs.mkdirSync(configsDir, { recursive: true });
    fs.writeFileSync(path.join(configsDir, 'usage-cache.json'), JSON.stringify(data, null, 2), 'utf8');
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-usage-cache-'));
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('usage cache TTL', () => {
    test('returns fresh cached usage within the default 1 hour TTL', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T11:30:00.000Z',
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now })).resolves.toMatchObject({
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });
    });

    test('treats cached usage older than 1 hour as stale by default', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T10:59:59.999Z',
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now })).resolves.toBeNull();
    });

    test('can read cache without TTL for internal mutation paths', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T00:00:00.000Z',
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now, maxAgeMs: null })).resolves.toMatchObject({
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });
    });
});
