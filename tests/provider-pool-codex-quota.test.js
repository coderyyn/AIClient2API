import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { getAccountTokenUsageSummary } from '../src/plugins/model-usage-stats/stats-manager.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/plugins/model-usage-stats/stats-manager.js', () => ({
    getAccountTokenUsageSummary: jest.fn()
}));

let consoleSpies = [];
let managers = [];
const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
let originalUsageCacheExisted = false;
let originalUsageCacheContent = null;

function writeCodexUsageCache(instances, timestamp = new Date().toISOString()) {
    fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
    fs.writeFileSync(usageCachePath, JSON.stringify({
        timestamp,
        providers: {
            'openai-codex-oauth': {
                providerType: 'openai-codex-oauth',
                instances
            }
        }
    }, null, 2), 'utf8');
}

function createQuotaPoolManager(overrides = {}) {
    const manager = new ProviderPoolManager({
        'openai-codex-oauth': [
            {
                uuid: 'aaa-codex-over',
                customName: 'Over',
                supportedModels: ['gpt-5.5'],
                codexMax5hTokens: 1000,
                codexMaxWeeklyTokens: 5000,
                ...overrides.over
            },
            {
                uuid: 'zzz-codex-ok',
                customName: 'OK',
                supportedModels: ['gpt-5.5'],
                codexMax5hTokens: 1000,
                codexMaxWeeklyTokens: 5000,
                ...overrides.ok
            }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
        }
    });
    managers.push(manager);
    return manager;
}

beforeEach(() => {
    originalUsageCacheExisted = fs.existsSync(usageCachePath);
    originalUsageCacheContent = originalUsageCacheExisted ? fs.readFileSync(usageCachePath, 'utf8') : null;
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    getAccountTokenUsageSummary.mockImplementation((provider, uuid) => {
        if (uuid === 'aaa-codex-over') {
            return { rolling5hTokens: 1200, weeklyTokens: 1000, totalTokens: 1200 };
        }
        return { rolling5hTokens: 100, weeklyTokens: 1000, totalTokens: 1000 };
    });
});

afterEach(() => {
    for (const manager of managers) {
        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
        }
    }
    managers = [];
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    jest.clearAllMocks();
    if (originalUsageCacheExisted) {
        fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
        fs.writeFileSync(usageCachePath, originalUsageCacheContent, 'utf8');
    } else if (fs.existsSync(usageCachePath)) {
        fs.rmSync(usageCachePath, { force: true });
    }
    originalUsageCacheExisted = false;
    originalUsageCacheContent = null;
});

describe('provider pool Codex token quota', () => {
    test('skips Codex accounts whose rolling 5h token usage exceeds provider limit', async () => {
        const manager = createQuotaPoolManager();

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('zzz-codex-ok');
    });

    test('throws 429 when every Codex account exceeds configured token quota', async () => {
        getAccountTokenUsageSummary.mockReturnValue({
            rolling5hTokens: 1200,
            weeklyTokens: 6000,
            totalTokens: 6000
        });
        const manager = createQuotaPoolManager();

        await expect(manager.selectProvider('openai-codex-oauth', 'gpt-5.5')).rejects.toMatchObject({
            status: 429
        });
    });

    test('skips Codex accounts whose official 5h usage percent exceeds configured percent limit', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 81, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 40, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: { codexMax5hTokens: 0, codexMaxWeeklyTokens: 0, codexMax5hPercent: 80 },
            ok: { codexMax5hTokens: 0, codexMaxWeeklyTokens: 0, codexMax5hPercent: 80 }
        });

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('zzz-codex-ok');
    });

    test('skips Codex accounts whose official weekly usage percent exceeds configured percent limit', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 20, unit: 'percent' },
                        { id: 'secondary_window', percent: 91, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 20, unit: 'percent' },
                        { id: 'secondary_window', percent: 70, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: { codexMax5hTokens: 0, codexMaxWeeklyTokens: 0, codexMaxWeeklyPercent: 90 },
            ok: { codexMax5hTokens: 0, codexMaxWeeklyTokens: 0, codexMaxWeeklyPercent: 90 }
        });

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('zzz-codex-ok');
    });

    test('does not skip Codex accounts based on stale official usage percent cache', async () => {
        const staleTimestamp = new Date(Date.now() - (11 * 60 * 1000)).toISOString();
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 99, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 40, unit: 'percent' }
                    ]
                }
            }
        ], staleTimestamp);

        const manager = createQuotaPoolManager({
            over: { codexMax5hTokens: 0, codexMaxWeeklyTokens: 0, codexMax5hPercent: 80 },
            ok: { codexMax5hTokens: 0, codexMaxWeeklyTokens: 0, codexMax5hPercent: 80 }
        });

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('aaa-codex-over');
    });
});
