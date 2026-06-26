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
    test('aggregates Codex account buckets by account identity across provider UUIDs', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Codex Client', 1000);
        for (const [providerUuid, totalTokens] of [['old-provider-uuid', 1100], ['new-provider-uuid', 2200]]) {
            await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
                requestCount: 1,
                promptTokens: totalTokens - 100,
                completionTokens: 100,
                totalTokens
            }, `req-${providerUuid}`, {
                providerUuid,
                providerName: 'user@example.com',
                accountIdentity: 'acct-chatgpt-123',
                timestamp: '2026-06-22T02:15:30.000Z'
            });
        }

        const [listedKey] = await listKeys();
        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:acct-chatgpt-123';
        const dayAccounts = listedKey.usageHistory['2026-06-22'].accounts;

        expect(Object.keys(dayAccounts)).toEqual([accountKey]);
        expect(dayAccounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'acct-chatgpt-123',
            accountIdentity: 'acct-chatgpt-123',
            providerName: 'user@example.com',
            providerUuids: ['old-provider-uuid', 'new-provider-uuid']
        });
        expect(dayAccounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 3300
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 3300
        });
    });

    test('listKeys weekly usage only includes the latest seven calendar days', async () => {
        jest.setSystemTime(new Date('2026-06-16T11:04:05.689Z'));
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Stale Client', 100);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100,
            cachedTokens: 200
        });

        jest.setSystemTime(new Date('2026-06-26T05:00:00.000Z'));

        const [listedKey] = await listKeys();

        expect(listedKey.lastUsedAt).toBeTruthy();
        expect(listedKey.weeklyUsage).toBe(0);
        expect(listedKey.weeklyTotalTokens).toBe(0);
        expect(listedKey.totalTokens).toBe(1100);
    });

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

    test('getStats aggregates provider account buckets for admin token-share UI', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, getStats } = await loadKeyManager();

        const keyA = await createKey('Image Client A', 1000);
        const keyB = await createKey('Image Client B', 1000);

        await incrementUsage(keyA.id, 'openai-codex-oauth', 'gpt-image-2', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300,
            cachedTokens: 800
        }, 'req-admin-account-1', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            timestamp: '2026-06-22T02:15:30.000Z'
        });
        await incrementUsage(keyB.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 3000,
            completionTokens: 500,
            totalTokens: 3500,
            cachedTokens: 600
        }, 'req-admin-account-2', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            timestamp: '2026-06-22T02:20:30.000Z'
        });

        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:codex-account-a';

        expect(stats.usageHistory['2026-06-22'].accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].summary).toMatchObject({
            requestCount: 3,
            totalTokens: 5800,
            cachedTokens: 1400
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].models['gpt-image-2']).toMatchObject({
            requestCount: 1,
            totalTokens: 2300
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].models['gpt-5.5']).toMatchObject({
            requestCount: 2,
            totalTokens: 3500
        });
    });

    test('getAccountUsageSummary returns account ranges for usage page data source', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-06-20T02:00:00.000Z'));
        const key = await createKey('Codex Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-month-only', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });

        jest.setSystemTime(new Date('2026-06-23T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 2000,
            completionTokens: 200,
            totalTokens: 2200
        }, 'req-week', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 3,
            promptTokens: 3000,
            completionTokens: 300,
            totalTokens: 3300
        }, 'req-today', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const account = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:codex-account-a');

        expect(summary).toMatchObject({
            source: 'potluck/model-usage-stats',
            timezone: 'Asia/Shanghai',
            periods: {
                today: '2026-06-26',
                week: '2026-06-22',
                month: '2026-06-01'
            }
        });
        expect(account).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A'
        });
        expect(account.today).toMatchObject({ requestCount: 3, totalTokens: 3300 });
        expect(account.week).toMatchObject({ requestCount: 5, totalTokens: 5500 });
        expect(account.month).toMatchObject({ requestCount: 6, totalTokens: 6600 });
    });

    test('listKeys exposes sanitized related account names for audit key selectors', async () => {
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Audit Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300,
            cachedTokens: 800
        }, 'req-audit-related-1', {
            providerUuid: 'codex-account-email',
            providerName: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 3,
            promptTokens: 6000,
            completionTokens: 300,
            totalTokens: 6300,
            cachedTokens: 1200
        }, 'req-audit-related-2', {
            providerUuid: 'codex-account-name',
            providerName: 'Codex Account A',
            timestamp: '2026-06-22T02:20:30.000Z'
        });

        const [listedKey] = await listKeys();

        expect(listedKey.audit.relatedNames).toEqual([
            'Codex Account A',
            expect.stringMatching(/^redacted-email:/)
        ]);
        expect(JSON.stringify(listedKey.audit.relatedNames)).not.toContain('user@example.com');
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
