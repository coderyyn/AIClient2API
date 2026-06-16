import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadStatsManager() {
    jest.resetModules();
    return await import('../src/plugins/model-usage-stats/stats-manager.js');
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-model-usage-'));
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('model usage account statistics', () => {
    test('records account, model, date, and cache hit ratio for a Codex provider instance', async () => {
        const statsManager = await loadStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'req-codex-1',
            model: 'gpt-5.5',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'US Account A',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 120,
                    total_tokens: 1120,
                    prompt_tokens_details: {
                        cached_tokens: 400
                    }
                }
            }
        });

        await statsManager.finalizeRequest({
            requestId: 'req-codex-1',
            model: 'gpt-5.5',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'US Account A',
            fromProvider: 'openai',
            isStream: false
        });

        const stats = await statsManager.getStats();
        const accountKey = 'openai-codex-oauth:codex-account-a';
        const [dateKey] = Object.keys(stats.daily);

        expect(stats.summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
        expect(stats.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'US Account A'
        });
        expect(stats.accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
        expect(stats.accounts[accountKey].models['gpt-5.5']).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
        expect(stats.daily[dateKey].models['gpt-5.5']).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
        expect(stats.daily[dateKey].accounts[accountKey].models['gpt-5.5']).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
    });
});
