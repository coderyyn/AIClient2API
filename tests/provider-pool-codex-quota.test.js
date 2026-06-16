import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
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
});
