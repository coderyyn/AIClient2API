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

async function loadPotluckPlugin() {
    jest.resetModules();
    return await import('../src/plugins/api-potluck/index.js');
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
            todayReasoningTokens: 0,
            totalTokens: 1120,
            totalReasoningTokens: 0,
            weeklyTotalTokens: 1120,
            weeklyReasoningTokens: 0,
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

    test('records provider account and hour buckets for a distributed key request', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Image Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-image-2', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300,
            cachedTokens: 800,
            reasoningTokens: 516
        }, 'req-image-1', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const [listedKey] = await listKeys();
        const dayHistory = listedKey.usageHistory['2026-06-22'];
        const accountKey = 'openai-codex-oauth:codex-account-a';

        expect(listedKey).toMatchObject({
            todayReasoningTokens: 516,
            totalReasoningTokens: 516,
            weeklyReasoningTokens: 516
        });
        expect(dayHistory.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });
        expect(dayHistory.accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 2300,
            cachedTokens: 800,
            reasoningTokens: 516,
            cacheHitRatio: 0.4
        });
        expect(dayHistory.accounts[accountKey].models['gpt-image-2']).toMatchObject({
            requestCount: 1,
            totalTokens: 2300,
            reasoningTokens: 516
        });
        expect(dayHistory.hours['10'].accounts[accountKey].models['gpt-image-2']).toMatchObject({
            requestCount: 1,
            totalTokens: 2300,
            reasoningTokens: 516
        });
    });

    test('records reasoning tokens through Potluck response hooks', async () => {
        const potluck = await loadPotluckPlugin();
        const key = await potluck.createKey('Codex Client', 1000);
        const requestId = 'req-codex-reasoning';

        await potluck.default.hooks.onUnaryResponse({
            requestId,
            nativeResponse: {
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 120,
                    total_tokens: 1120,
                    completion_tokens_details: {
                        reasoning_tokens: 516
                    }
                }
            }
        });
        await potluck.default.hooks.onContentGenerated({
            _monitorRequestId: requestId,
            potluckApiKey: key.id,
            toProvider: 'openai-codex-oauth',
            model: 'gpt-5.5',
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });

        const [listedKey] = await potluck.listKeys();
        const [dateKey] = Object.keys(listedKey.usageHistory);
        const accountKey = 'openai-codex-oauth:codex-account-a';

        expect(listedKey.todayReasoningTokens).toBe(516);
        expect(listedKey.usageHistory[dateKey].accounts[accountKey].models['gpt-5.5']).toMatchObject({
            reasoningTokens: 516
        });
    });
});
