import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

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

function hashSecretForTest(value, length = 16) {
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
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
    test('uses usage ledger as the shared fact source for key and account summaries', async () => {
        jest.setSystemTime(new Date('2026-07-01T04:00:00.000Z'));
        const keyId = 'maki_ledger_shared_fact';
        const keyHash = hashSecretForTest(keyId);
        fs.writeFileSync(path.join(tempDir, 'configs', 'api-potluck-keys.json'), JSON.stringify({
            keys: {
                [keyId]: {
                    id: keyId,
                    name: 'Ledger Client',
                    createdAt: '2026-07-01T00:00:00.000Z',
                    dailyLimit: 1000,
                    todayUsage: 0,
                    totalUsage: 0,
                    lastResetDate: '2026-07-01',
                    enabled: true,
                    usageHistory: {}
                }
            }
        }), 'utf8');
        const ledgerDir = path.join(tempDir, 'configs', 'usage-ledger');
        fs.mkdirSync(ledgerDir, { recursive: true });
        fs.writeFileSync(path.join(ledgerDir, 'usage-2026-07-01.jsonl'), [
            {
                schemaVersion: 1,
                timestamp: '2026-07-01T02:00:00.000Z',
                beijingDate: '2026-07-01',
                requestId: 'req-ledger-1',
                potluckKeyHash: keyHash,
                potluckKeyId: keyId,
                potluckKeyName: 'Ledger Client',
                provider: 'openai-codex-oauth',
                providerUuid: 'provider-a',
                accountEmail: 'ledger@example.com',
                accountDisplay: 'Ledger Account',
                requestedModel: 'gpt-5.3-codex-spark',
                actualModel: 'gpt-5.4-mini',
                requestCount: 1,
                promptTokens: 1000,
                cachedTokens: 400,
                completionTokens: 100,
                totalTokens: 1100,
                source: 'api-potluck'
            },
            {
                schemaVersion: 1,
                timestamp: '2026-07-01T03:00:00.000Z',
                beijingDate: '2026-07-01',
                requestId: 'req-ledger-2',
                potluckKeyHash: keyHash,
                potluckKeyId: keyId,
                potluckKeyName: 'Ledger Client',
                provider: 'openai-codex-oauth',
                providerUuid: 'provider-a',
                accountEmail: 'ledger@example.com',
                accountDisplay: 'Ledger Account',
                requestedModel: 'gpt-image-2',
                actualModel: 'gpt-image-2',
                requestCount: 1,
                promptTokens: 200,
                completionTokens: 100,
                totalTokens: 300,
                source: 'api-potluck'
            }
        ].map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');

        const { listKeys, getStats, getAccountUsageSummary } = await loadKeyManager();
        const [listedKey] = await listKeys();
        const stats = await getStats();
        const accountSummary = await getAccountUsageSummary(new Date('2026-07-01T04:00:00.000Z'));
        const account = accountSummary.accounts.find(item => item.accountKey === 'openai-codex-oauth:ledger@example.com');

        expect(listedKey.usageHistory['2026-07-01'].summary).toMatchObject({
            requestCount: 2,
            promptTokens: 1200,
            cachedTokens: 400,
            completionTokens: 200,
            totalTokens: 1400
        });
        expect(stats).toMatchObject({
            usageFactSource: 'usage-ledger',
            todayTotalUsage: 2,
            todayTotalTokens: 1400,
            totalTokens: 1400
        });
        expect(stats.usageHistory['2026-07-01'].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 1400
        });
        expect(accountSummary.source).toBe('usage-ledger');
        expect(account.today).toMatchObject({
            requestCount: 2,
            totalTokens: 1400
        });
        expect(account.week).toMatchObject({
            requestCount: 2,
            totalTokens: 1400
        });
    });

    test('does not double count duplicate request ids and only applies usage deltas', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Dedup Client', 1000);
        const context = {
            providerUuid: 'provider-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        };

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            completionTokens: 120,
            reasoningTokens: 80,
            totalTokens: 1120
        }, 'req-duplicate', context);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            completionTokens: 120,
            reasoningTokens: 80,
            totalTokens: 1120
        }, 'req-duplicate', context);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1300,
            cachedTokens: 500,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450
        }, 'req-duplicate', context);

        const [listedKey] = await listKeys();
        const accountKey = 'openai-codex-oauth:user@example.com';

        expect(listedKey.todayUsage).toBe(1);
        expect(listedKey.todayPromptTokens).toBe(1300);
        expect(listedKey.todayCompletionTokens).toBe(150);
        expect(listedKey.todayReasoningTokens).toBe(90);
        expect(listedKey.todayTotalTokens).toBe(1450);
        expect(listedKey.usageHistory['2026-06-22'].summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1300,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450,
            cachedTokens: 500
        });
        expect(listedKey.usageHistory['2026-06-22'].accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1450
        });

        const ledgerRows = fs.readFileSync(path.join(tempDir, 'configs', 'usage-ledger', 'usage-2026-06-22.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
        expect(ledgerRows).toHaveLength(1);
        expect(ledgerRows[0]).toMatchObject({
            requestId: 'req-duplicate',
            potluckKeyId: key.id,
            provider: 'openai-codex-oauth',
            accountEmail: 'user@example.com',
            actualModel: 'gpt-5.4-mini',
            promptTokens: 1300,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450
        });
    });

    test('aggregates Codex account buckets by email across provider UUIDs', async () => {
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
                accountEmail: 'user@example.com',
                timestamp: '2026-06-22T02:15:30.000Z'
            });
        }

        const [listedKey] = await listKeys();
        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';
        const dayAccounts = listedKey.usageHistory['2026-06-22'].accounts;

        expect(Object.keys(dayAccounts)).toEqual([accountKey]);
        expect(dayAccounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
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
            accountEmail: 'codex-a@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const [listedKey] = await listKeys();
        const dayHistory = listedKey.usageHistory['2026-06-22'];
        const accountKey = 'openai-codex-oauth:codex-a@example.com';

        expect(listedKey).toMatchObject({
            todayReasoningTokens: 516,
            totalReasoningTokens: 516,
            weeklyReasoningTokens: 516
        });
        expect(dayHistory.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-a@example.com',
            accountIdentity: 'codex-a@example.com',
            accountEmail: 'codex-a@example.com',
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
            accountEmail: 'codex-a@example.com',
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
            accountEmail: 'codex-a@example.com',
            timestamp: '2026-06-22T02:20:30.000Z'
        });

        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:codex-a@example.com';

        expect(stats.usageHistory['2026-06-22'].accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-a@example.com',
            accountIdentity: 'codex-a@example.com',
            accountEmail: 'codex-a@example.com',
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
            cachedTokens: 100,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-month-only', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        jest.setSystemTime(new Date('2026-06-23T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 2000,
            cachedTokens: 400,
            completionTokens: 200,
            totalTokens: 2200
        }, 'req-week', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 3,
            promptTokens: 3000,
            cachedTokens: 600,
            completionTokens: 300,
            totalTokens: 3300
        }, 'req-today', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const account = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:codex-a@example.com');

        expect(summary).toMatchObject({
            source: 'usage-ledger',
            timezone: 'Asia/Shanghai',
            periods: {
                today: '2026-06-26',
                week: '2026-06-20',
                month: '2026-05-28'
            }
        });
        expect(account).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-a@example.com',
            accountIdentity: 'codex-a@example.com',
            accountEmail: 'codex-a@example.com',
            providerName: 'Codex Account A'
        });
        expect(account.today).toMatchObject({ requestCount: 3, totalTokens: 3300, cachedTokens: 600, cacheHitRatio: 0.2 });
        expect(account.week).toMatchObject({ requestCount: 6, totalTokens: 6600, cachedTokens: 1100 });
        expect(account.week.cacheHitRatio).toBeCloseTo(1100 / 6000);
        expect(account.month.cacheHitRatio).toBeCloseTo(1100 / 6000);
        expect(account.today.cost).toMatchObject({
            actualUsd: 0.0213,
            missingPriceTokens: 0
        });
        expect(account.week.cost).toMatchObject({
            actualUsd: 0.043050000000000005,
            missingPriceTokens: 0
        });
        expect(account.month.cost).toMatchObject({
            actualUsd: 0.043050000000000005,
            missingPriceTokens: 0
        });
        expect(account.lastUsedAt).toBe('2026-06-26T02:00:00.000Z');
        expect(account.today.lastUsedAt).toBe('2026-06-26T02:00:00.000Z');
    });

    test('getAccountUsageSummary reports missing price tokens only for unknown models', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        const key = await createKey('Mixed Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-known-model', {
            providerUuid: 'known-account',
            providerName: 'known@example.com',
            accountEmail: 'known@example.com'
        });
        await incrementUsage(key.id, 'openai-codex-oauth', 'unknown-future-model', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300
        }, 'req-unknown-model', {
            providerUuid: 'unknown-account',
            providerName: 'unknown@example.com',
            accountEmail: 'unknown@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const knownAccount = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:known@example.com');
        const unknownAccount = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:unknown@example.com');

        expect(knownAccount.today.cost).toMatchObject({
            actualUsd: 0.0012,
            missingPriceTokens: 0
        });
        expect(unknownAccount.today.cost).toMatchObject({
            actualUsd: 0,
            missingPriceTokens: 2300
        });
    });

    test('getAccountUsageSummary uses a rolling 30 day month window from model usage daily history', async () => {
        fs.writeFileSync(path.join(tempDir, 'configs', 'model-usage-stats.json'), JSON.stringify({
            updatedAt: '2026-07-02T09:00:00.000Z',
            daily: {
                '2026-06-02': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 7,
                                promptTokens: 7000,
                                completionTokens: 700,
                                totalTokens: 7700,
                                lastUsedAt: '2026-06-02T02:00:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 7,
                                    promptTokens: 7000,
                                    completionTokens: 700,
                                    totalTokens: 7700,
                                    lastUsedAt: '2026-06-02T02:00:00.000Z'
                                }
                            }
                        }
                    }
                },
                '2026-06-03': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 5,
                                promptTokens: 5000,
                                completionTokens: 500,
                                totalTokens: 5500,
                                lastUsedAt: '2026-06-03T02:00:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 5,
                                    promptTokens: 5000,
                                    completionTokens: 500,
                                    totalTokens: 5500,
                                    lastUsedAt: '2026-06-03T02:00:00.000Z'
                                }
                            }
                        }
                    }
                },
                '2026-07-01': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 2,
                                promptTokens: 2000,
                                completionTokens: 200,
                                totalTokens: 2200,
                                lastUsedAt: '2026-07-01T02:00:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 2,
                                    promptTokens: 2000,
                                    completionTokens: 200,
                                    totalTokens: 2200,
                                    lastUsedAt: '2026-07-01T02:00:00.000Z'
                                }
                            }
                        }
                    }
                },
                '2026-07-02': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 3,
                                promptTokens: 3000,
                                completionTokens: 300,
                                totalTokens: 3300,
                                lastUsedAt: '2026-07-02T02:00:00.000Z'
                            },
                            models: {
                                'gpt-image-2': {
                                    requestCount: 3,
                                    promptTokens: 3000,
                                    completionTokens: 300,
                                    totalTokens: 3300,
                                    lastUsedAt: '2026-07-02T02:00:00.000Z'
                                }
                            }
                        }
                    }
                }
            }
        }), 'utf8');

        const { getAccountUsageSummary } = await loadKeyManager();
        const summary = await getAccountUsageSummary(new Date('2026-07-02T03:00:00.000Z'));
        const account = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:daily@example.com');

        expect(account.today).toMatchObject({
            requestCount: 3,
            totalTokens: 3300
        });
        expect(account.month).toMatchObject({
            requestCount: 10,
            totalTokens: 11000
        });
        expect(summary.periods.month).toBe('2026-06-03');
        expect(account.today.cost.missingPriceTokens).toBe(0);
    });

    test('getAccountUsageSummary merges Codex buckets by email across provider UUID and identity changes', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-06-24T02:00:00.000Z'));
        const key = await createKey('Codex Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 4,
            promptTokens: 3900,
            completionTokens: 100,
            totalTokens: 4000
        }, 'req-legacy-provider-uuid', {
            providerUuid: 'old-provider-uuid',
            providerName: 'user@example.com'
        });

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 1900,
            completionTokens: 100,
            totalTokens: 2000
        }, 'req-account-identity', {
            providerUuid: 'old-provider-uuid',
            providerName: 'user@example.com',
            accountIdentity: 'acct-chatgpt-123',
            accountEmail: 'user@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const matchingAccounts = summary.accounts.filter(account =>
            account.provider === 'openai-codex-oauth'
            && (
                account.accountEmail === 'user@example.com'
                || account.providerName === 'user@example.com'
                || account.providerUuids.includes('old-provider-uuid')
            )
        );

        expect(matchingAccounts).toHaveLength(1);
        expect(matchingAccounts[0]).toMatchObject({
            accountKey: 'openai-codex-oauth:user@example.com',
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerName: 'user@example.com',
            providerUuids: ['old-provider-uuid']
        });
        expect(matchingAccounts[0].today).toMatchObject({ requestCount: 2, totalTokens: 2000 });
        expect(matchingAccounts[0].week).toMatchObject({ requestCount: 6, totalTokens: 6000 });
        expect(matchingAccounts[0].month).toMatchObject({ requestCount: 6, totalTokens: 6000 });
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
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        const [listedKey] = await potluck.listKeys();
        const [dateKey] = Object.keys(listedKey.usageHistory);
        const accountKey = 'openai-codex-oauth:codex-a@example.com';

        expect(listedKey.todayReasoningTokens).toBe(516);
        expect(listedKey.todayCompletionTokens).toBe(120);
        expect(listedKey.todayTotalTokens).toBe(1120);
        expect(listedKey.usageHistory[dateKey].accounts[accountKey].models['gpt-5.5']).toMatchObject({
            completionTokens: 120,
            reasoningTokens: 516
        });
    });

    test('listKeys and getStats expose actual and gemini converted cost estimates', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Cost Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000000,
            cachedTokens: 200000,
            completionTokens: 100000,
            totalTokens: 1100000
        }, 'req-cost-1', {
            providerUuid: 'codex-account-a',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const [listedKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const stats = await getStats({ conversionModel: 'gemini-2.5-flash' });

        expect(listedKey.cost).toMatchObject({
            actualUsd: expect.closeTo(1.065, 6),
            convertedUsd: expect.closeTo(0.496, 6),
            conversionModel: 'gemini-2.5-flash',
            pricingVersion: 'official-2026-07-01',
            missingPriceTokens: 0
        });
        expect(listedKey.usageHistory['2026-06-22'].summary.cost).toMatchObject({
            actualUsd: expect.closeTo(1.065, 6),
            convertedUsd: expect.closeTo(0.496, 6)
        });
        expect(stats.cost).toMatchObject({
            actualUsd: expect.closeTo(1.065, 6),
            convertedUsd: expect.closeTo(0.496, 6)
        });
    });

    test('retains 35 days of per-key usage history', async () => {
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('History Client', 1000);
        for (let offset = 0; offset < 36; offset++) {
            const date = new Date(Date.UTC(2026, 5, 1 + offset, 1, 0, 0));
            jest.setSystemTime(date);
            await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
                requestCount: 1,
                promptTokens: 1000,
                completionTokens: 100,
                totalTokens: 1100
            }, `req-history-${offset}`, {
                providerUuid: 'codex-account-a',
                timestamp: date.toISOString()
            });
        }

        const [listedKey] = await listKeys();
        const dates = Object.keys(listedKey.usageHistory).sort();

        expect(dates).toHaveLength(35);
        expect(dates[0]).toBe('2026-06-02');
        expect(dates.at(-1)).toBe('2026-07-06');
    });

    test('keeps cumulative actual cost by model after old daily history is trimmed', async () => {
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Cumulative Cost Client', 1000);
        for (let offset = 0; offset < 36; offset++) {
            const date = new Date(Date.UTC(2026, 5, 1 + offset, 1, 0, 0));
            jest.setSystemTime(date);
            await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
                requestCount: 1,
                promptTokens: 1000000,
                completionTokens: 100000,
                totalTokens: 1100000
            }, `req-cumulative-cost-${offset}`, {
                providerUuid: 'codex-account-a',
                timestamp: date.toISOString()
            });
        }

        const [listedKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const stats = await getStats({ conversionModel: 'gemini-2.5-flash' });

        expect(Object.keys(listedKey.usageHistory)).toHaveLength(35);
        expect(listedKey.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
        expect(listedKey.cost.convertedUsd).toBeCloseTo(36 * 0.55, 6);
        expect(stats.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
    });

    test('trims over-retained persisted history on load while preserving cumulative model cost', async () => {
        const usageHistory = {};
        for (let offset = 0; offset < 36; offset++) {
            const date = new Date(Date.UTC(2026, 5, 1 + offset)).toISOString().slice(0, 10);
            usageHistory[date] = {
                summary: {
                    requestCount: 1,
                    promptTokens: 1000000,
                    completionTokens: 100000,
                    totalTokens: 1100000
                },
                models: {
                    'gpt-5.4-mini': {
                        requestCount: 1,
                        promptTokens: 1000000,
                        completionTokens: 100000,
                        totalTokens: 1100000
                    }
                }
            };
        }
        fs.writeFileSync(path.join(tempDir, 'configs', 'api-potluck-keys.json'), JSON.stringify({
            keys: {
                maki_persisted_history: {
                    id: 'maki_persisted_history',
                    name: 'Persisted History',
                    createdAt: '2026-06-01T00:00:00.000Z',
                    dailyLimit: 1000,
                    todayUsage: 0,
                    totalUsage: 36,
                    totalPromptTokens: 36000000,
                    totalCompletionTokens: 3600000,
                    totalTokens: 39600000,
                    usageHistory,
                    lastResetDate: '2026-07-06',
                    enabled: true
                }
            }
        }), 'utf8');

        const { listKeys, getStats } = await loadKeyManager();
        const [listedKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const stats = await getStats({ conversionModel: 'gemini-2.5-flash' });
        const dates = Object.keys(listedKey.usageHistory).sort();

        expect(dates).toHaveLength(35);
        expect(dates[0]).toBe('2026-06-02');
        expect(listedKey.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
        expect(Object.keys(stats.usageHistory)).toHaveLength(35);
        expect(stats.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
    });

    test('list summary mode merges ledger dates with legacy key history without returning heavy day details', async () => {
        jest.setSystemTime(new Date('2026-07-01T04:00:00.000Z'));
        const keyId = 'maki_legacy_fallback';
        const keyHash = hashSecretForTest(keyId);
        fs.writeFileSync(path.join(tempDir, 'configs', 'api-potluck-keys.json'), JSON.stringify({
            keys: {
                [keyId]: {
                    id: keyId,
                    name: 'Legacy Client',
                    createdAt: '2026-06-20T00:00:00.000Z',
                    dailyLimit: 1000,
                    totalUsage: 2,
                    totalPromptTokens: 3000,
                    totalCompletionTokens: 300,
                    totalTokens: 3300,
                    totalModels: {
                        'gpt-5.4-mini': {
                            requestCount: 2,
                            promptTokens: 3000,
                            completionTokens: 300,
                            totalTokens: 3300
                        }
                    },
                    lastResetDate: '2026-07-01',
                    enabled: true,
                    usageHistory: {
                        '2026-06-29': {
                            summary: {
                                requestCount: 1,
                                promptTokens: 1000,
                                cachedTokens: 200,
                                completionTokens: 100,
                                totalTokens: 1100
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 1,
                                    promptTokens: 1000,
                                    cachedTokens: 200,
                                    completionTokens: 100,
                                    totalTokens: 1100
                                }
                            },
                            accounts: {
                                'openai-codex-oauth:legacy@example.com': {
                                    provider: 'openai-codex-oauth',
                                    providerUuid: 'legacy@example.com',
                                    summary: { requestCount: 1, totalTokens: 1100 },
                                    models: {}
                                }
                            }
                        }
                    }
                }
            }
        }), 'utf8');
        const ledgerDir = path.join(tempDir, 'configs', 'usage-ledger');
        fs.mkdirSync(ledgerDir, { recursive: true });
        fs.writeFileSync(path.join(ledgerDir, 'usage-summary.json'), JSON.stringify({
            generatedAt: '2026-07-01T04:00:00.000Z',
            usageHistory: {
                '2026-07-01': {
                    summary: {
                        requestCount: 1,
                        promptTokens: 2000,
                        cachedTokens: 600,
                        completionTokens: 200,
                        totalTokens: 2200
                    },
                    models: {
                        'gpt-5.4-mini': {
                            requestCount: 1,
                            promptTokens: 2000,
                            cachedTokens: 600,
                            completionTokens: 200,
                            totalTokens: 2200
                        }
                    },
                    accounts: {},
                    providers: {},
                    hours: {}
                }
            },
            byKeyHash: {
                [keyHash]: {
                    usageHistory: {
                        '2026-07-01': {
                            summary: {
                                requestCount: 1,
                                promptTokens: 2000,
                                cachedTokens: 600,
                                completionTokens: 200,
                                totalTokens: 2200
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 1,
                                    promptTokens: 2000,
                                    cachedTokens: 600,
                                    completionTokens: 200,
                                    totalTokens: 2200
                                }
                            },
                            accounts: {},
                            providers: {},
                            hours: {}
                        }
                    },
                    totals: { requestCount: 1, promptTokens: 2000, cachedTokens: 600, completionTokens: 200, totalTokens: 2200 },
                    models: {
                        'gpt-5.4-mini': { requestCount: 1, promptTokens: 2000, cachedTokens: 600, completionTokens: 200, totalTokens: 2200 }
                    }
                }
            },
            totals: { requestCount: 1, promptTokens: 2000, cachedTokens: 600, completionTokens: 200, totalTokens: 2200 },
            models: {
                'gpt-5.4-mini': { requestCount: 1, promptTokens: 2000, cachedTokens: 600, completionTokens: 200, totalTokens: 2200 }
            }
        }), 'utf8');

        const { listKeys, getKey } = await loadKeyManager();
        const [listedKey] = await listKeys({ summaryOnly: true });
        const detailKey = await getKey(keyId);

        expect(Object.keys(listedKey.usageHistory).sort()).toEqual(['2026-06-29', '2026-07-01']);
        expect(listedKey.usageHistory['2026-06-29'].summary).toMatchObject({ requestCount: 1, totalTokens: 1100 });
        expect(listedKey.usageHistory['2026-06-29'].accounts).toBeUndefined();
        expect(listedKey.usageHistory['2026-07-01'].summary).toMatchObject({ requestCount: 1, totalTokens: 2200 });
        expect(listedKey.usageHistory['2026-07-01'].models).toBeUndefined();
        expect(detailKey.usageHistory['2026-06-29'].accounts['openai-codex-oauth:legacy@example.com'].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1100
        });
        expect(detailKey.usageHistory['2026-07-01'].models['gpt-5.4-mini']).toMatchObject({
            requestCount: 1,
            totalTokens: 2200
        });
    });

    test('getAccountUsageSummary merges display-name aliases that differ only by case', async () => {
        jest.setSystemTime(new Date('2026-07-01T04:00:00.000Z'));
        const ledgerDir = path.join(tempDir, 'configs', 'usage-ledger');
        fs.mkdirSync(ledgerDir, { recursive: true });
        fs.writeFileSync(path.join(ledgerDir, 'usage-summary.json'), JSON.stringify({
            generatedAt: '2026-07-01T04:00:00.000Z',
            usageHistory: {
                '2026-07-01': {
                    summary: { requestCount: 2, promptTokens: 3000, completionTokens: 300, totalTokens: 3300 },
                    models: {},
                    providers: {},
                    hours: {},
                    accounts: {
                        'openai-codex-oauth:GaulinRosiles6731': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'GaulinRosiles6731',
                            accountIdentity: 'GaulinRosiles6731',
                            providerName: 'GaulinRosiles6731',
                            summary: { requestCount: 1, promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
                            models: {}
                        },
                        'openai-codex-oauth:gaulinrosiles6731': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'gaulinrosiles6731',
                            accountIdentity: 'gaulinrosiles6731',
                            providerName: 'gaulinrosiles6731',
                            summary: { requestCount: 1, promptTokens: 2000, completionTokens: 200, totalTokens: 2200 },
                            models: {}
                        }
                    }
                }
            },
            byKeyHash: {},
            totals: { requestCount: 2, promptTokens: 3000, completionTokens: 300, totalTokens: 3300 },
            models: {}
        }), 'utf8');

        const { getAccountUsageSummary } = await loadKeyManager();
        const summary = await getAccountUsageSummary(new Date('2026-07-01T04:00:00.000Z'));

        expect(summary.accounts).toHaveLength(1);
        expect(summary.accounts[0].today).toMatchObject({
            requestCount: 2,
            totalTokens: 3300
        });
    });
});
