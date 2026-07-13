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
    test('aggregates Codex account stats by email across provider reauthorization UUIDs', async () => {
        const statsManager = await loadStatsManager();

        for (const providerUuid of ['old-provider-uuid', 'new-provider-uuid']) {
            const requestId = `req-${providerUuid}`;
            statsManager.recordUnaryUsage({
                requestId,
                model: 'gpt-5.5',
                provider: 'openai-codex-oauth',
                providerUuid,
                providerName: 'user@example.com',
                accountIdentity: 'acct-chatgpt-123',
                accountEmail: 'User@Example.com',
                fromProvider: 'openai',
                nativeResponse: {
                    usage: {
                        prompt_tokens: 1000,
                        completion_tokens: 100,
                        total_tokens: 1100
                    }
                }
            });

            await statsManager.finalizeRequest({
                requestId,
                model: 'gpt-5.5',
                provider: 'openai-codex-oauth',
                providerUuid,
                providerName: 'user@example.com',
                accountIdentity: 'acct-chatgpt-123',
                accountEmail: 'User@Example.com',
                fromProvider: 'openai',
                isStream: false
            });
        }

        const stats = await statsManager.getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';

        expect(Object.keys(stats.accounts).filter(key => key.startsWith('openai-codex-oauth:'))).toEqual([accountKey]);
        expect(stats.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerName: 'user@example.com',
            providerUuids: ['old-provider-uuid', 'new-provider-uuid']
        });
        expect(stats.accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 2200
        });
    });

    test('aggregates same Codex email across oauth and responses providers into one account', async () => {
        const statsManager = await loadStatsManager();

        for (const provider of ['openai-codex-oauth', 'openaiResponses-custom']) {
            const requestId = `req-${provider}`;
            statsManager.recordUnaryUsage({
                requestId,
                model: 'gpt-5.5',
                provider,
                providerUuid: 'same-provider-uuid',
                providerName: 'User@Example.com',
                accountEmail: 'User@Example.com',
                fromProvider: 'openai',
                nativeResponse: {
                    usage: {
                        prompt_tokens: 1000,
                        completion_tokens: 100,
                        total_tokens: 1100
                    }
                }
            });

            await statsManager.finalizeRequest({
                requestId,
                model: 'gpt-5.5',
                provider,
                providerUuid: 'same-provider-uuid',
                providerName: 'User@Example.com',
                accountEmail: 'User@Example.com',
                fromProvider: 'openai',
                isStream: false
            });
        }

        const stats = await statsManager.getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';

        expect(Object.keys(stats.accounts)).toEqual([accountKey]);
        expect(stats.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerUuids: ['same-provider-uuid']
        });
        expect(stats.accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 2200
        });
    });

    test('records account, model, date, and cache hit ratio for a Codex provider instance', async () => {
        const statsManager = await loadStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'req-codex-1',
            model: 'gpt-5.5',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 120,
                    total_tokens: 1120,
                    completion_tokens_details: {
                        reasoning_tokens: 516
                    },
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
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            fromProvider: 'openai',
            isStream: false
        });

        const stats = await statsManager.getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';
        const [dateKey] = Object.keys(stats.daily);

        expect(stats.summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 120,
            reasoningTokens: 516,
            totalTokens: 1120,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
        expect(stats.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerName: 'user@example.com',
            providerUuids: ['codex-account-a']
        });
        expect(stats.accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 120,
            reasoningTokens: 516,
            totalTokens: 1120,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
        expect(stats.accounts[accountKey].models['gpt-5.5']).toMatchObject({
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 120,
            reasoningTokens: 516,
            totalTokens: 1120,
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

    test('records model usage under the actual fallback model instead of the requested 5.3 model', async () => {
        const statsManager = await loadStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'req-codex-fallback-model',
            model: 'gpt-5.4-mini',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120
                }
            }
        });

        await statsManager.finalizeRequest({
            requestId: 'req-codex-fallback-model',
            model: 'gpt-5.4-mini',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            fromProvider: 'openai',
            isStream: false
        });

        const stats = await statsManager.getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';
        const [dateKey] = Object.keys(stats.daily);

        expect(stats.providers['openai-codex-oauth'].models['gpt-5.4-mini']).toMatchObject({
            requestCount: 1,
            totalTokens: 120
        });
        expect(stats.providers['openai-codex-oauth'].models['gpt-5.3-codex-spark']).toBeUndefined();
        expect(stats.accounts[accountKey].models['gpt-5.4-mini']).toMatchObject({
            requestCount: 1,
            totalTokens: 120
        });
        expect(stats.accounts[accountKey].models['gpt-5.3-codex-spark']).toBeUndefined();
        expect(stats.daily[dateKey].models['gpt-5.4-mini']).toMatchObject({
            requestCount: 1,
            totalTokens: 120
        });
        expect(stats.daily[dateKey].models['gpt-5.3-codex-spark']).toBeUndefined();
    });

    test('logs per-request account quota snapshot and token usage for Codex accounts', async () => {
        fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'configs', 'usage-cache.json'), JSON.stringify({
            timestamp: new Date(Date.now() - 5000).toISOString(),
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    instances: [{
                        uuid: 'codex-account-a',
                        name: 'US Account A',
                        usage: {
                            items: [
                                { id: 'primary_window', label: 'Request Quota (5h)', percent: 73.5, unit: 'percent' },
                                { id: 'secondary_window', label: 'Weekly Limit', percent: 37, unit: 'percent' }
                            ]
                        }
                    }]
                }
            }
        }), 'utf8');
        const logSpy = jest.spyOn(console, 'log');
        const statsManager = await loadStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'req-codex-audit',
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
                    completion_tokens_details: {
                        reasoning_tokens: 516
                    },
                    prompt_tokens_details: {
                        cached_tokens: 400
                    }
                }
            }
        });

        await statsManager.finalizeRequest({
            requestId: 'req-codex-audit',
            model: 'gpt-5.5',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'US Account A',
            fromProvider: 'openai',
            isStream: false
        });

        const logged = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
        expect(logged).toContain('[Request Audit][req-codex-audit]');
        expect(logged).toContain('Provider: openai-codex-oauth');
        expect(logged).toContain('Account: US Account A');
        expect(logged).toContain('UUID: codex-account-a');
        expect(logged).toContain('5h: 73.5% used/26.5% remaining');
        expect(logged).toContain('Weekly: 37% used/63% remaining');
        expect(logged).toContain('UsageCacheAgeMs:');
        expect(logged).toContain('Prompt: 1000');
        expect(logged).toContain('Completion: 120');
        expect(logged).toContain('Total: 1120');
        expect(logged).toContain('Cached: 400');
        expect(logged).toContain('Reasoning: 516');
    });

    test('logs a weekly-only primary window as Weekly and leaves 5h unavailable', async () => {
        fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'configs', 'usage-cache.json'), JSON.stringify({
            timestamp: new Date(Date.now() - 5000).toISOString(),
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    instances: [{
                        uuid: 'codex-account-a',
                        name: 'US Account A',
                        usage: {
                            items: [{
                                id: 'primary_window',
                                label: 'Weekly Limit',
                                windowKind: 'weekly',
                                durationSeconds: 604800,
                                percent: 73.5,
                                unit: 'percent'
                            }]
                        }
                    }]
                }
            }
        }), 'utf8');
        const logSpy = jest.spyOn(console, 'log');
        const statsManager = await loadStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'req-codex-weekly-only',
            model: 'gpt-5.5',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'US Account A',
            nativeResponse: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
        });
        await statsManager.finalizeRequest({
            requestId: 'req-codex-weekly-only',
            model: 'gpt-5.5',
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'US Account A',
            isStream: false
        });

        const logged = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
        expect(logged).toContain('5h: unavailable');
        expect(logged).toContain('Weekly: 73.5% used/26.5% remaining');
    });

    test('reuses usage cache snapshot for request audit logs within the short ttl window', async () => {
        const configsDir = path.join(tempDir, 'configs');
        const usageCachePath = path.join(configsDir, 'usage-cache.json');
        fs.mkdirSync(configsDir, { recursive: true });
        fs.writeFileSync(usageCachePath, JSON.stringify({
            timestamp: new Date(Date.now() - 5000).toISOString(),
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    instances: [{
                        uuid: 'codex-account-a',
                        name: 'US Account A',
                        usage: {
                            items: [
                                { id: 'primary_window', label: 'Request Quota (5h)', percent: 73.5, unit: 'percent' }
                            ]
                        }
                    }]
                }
            }
        }), 'utf8');

        const readSpy = jest.spyOn(fs, 'readFileSync');
        const statsManager = await loadStatsManager();

        for (const requestId of ['req-codex-audit-cache-1', 'req-codex-audit-cache-2']) {
            statsManager.recordUnaryUsage({
                requestId,
                model: 'gpt-5.5',
                provider: 'openai-codex-oauth',
                providerUuid: 'codex-account-a',
                providerName: 'US Account A',
                nativeResponse: {
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                        total_tokens: 12,
                        prompt_tokens_details: {
                            cached_tokens: 4
                        }
                    }
                }
            });

            await statsManager.finalizeRequest({
                requestId,
                model: 'gpt-5.5',
                provider: 'openai-codex-oauth',
                providerUuid: 'codex-account-a',
                providerName: 'US Account A',
                isStream: false
            });
        }

        const usageCacheReads = readSpy.mock.calls
            .map(([filePath]) => String(filePath))
            .filter(filePath => path.normalize(filePath) === path.normalize(usageCachePath));

        expect(usageCacheReads).toHaveLength(1);
    });
});
