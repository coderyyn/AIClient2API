import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadKeyManager() {
    jest.resetModules();
    return await import('../src/plugins/api-potluck/key-manager.js');
}

beforeEach(() => {
    jest.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('api potluck key usage summary', () => {
    test('listKeys exposes token-first daily weekly and cumulative usage fields', async () => {
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Alpha', 100);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 120,
            totalTokens: 1120,
            cachedTokens: 400
        });

        const [listedKey] = await listKeys();
        const [dateKey] = Object.keys(listedKey.usageHistory);

        expect(listedKey).toMatchObject({
            todayTotalTokens: 1120,
            totalTokens: 1120,
            weeklyTotalTokens: 1120,
            todayCacheHitRatio: 0.4,
            weeklyCacheHitRatio: 0.4,
            totalCacheHitRatio: 0.4
        });
        expect(listedKey.usageHistory[dateKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1120,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
    });
});
