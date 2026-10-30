import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { applyProviderRateLimitCooldown } from '../src/utils/common.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openaiResponses-custom']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let consoleSpies = [];
const managers = [];

function createManager(providers) {
    const manager = new ProviderPoolManager({ 'openaiResponses-custom': providers }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: { PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json' }
    });
    managers.push(manager);
    return manager;
}

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(new Date('2026-10-30T02:00:00Z')); // 上海 10-30 10:00
});

afterEach(() => {
    managers.splice(0).forEach((manager) => clearTimeout(manager.saveTimer));
    jest.useRealTimers();
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('provider pool quota reset ordering', () => {
    test('selects the key whose monthly reset comes soonest', async () => {
        const manager = createManager([
            { uuid: 'reset-14', customName: 'A', accountEmail: 'a@example.com', quotaResetDay: 14 },
            { uuid: 'reset-3', customName: 'B', accountEmail: 'b@example.com', quotaResetDay: 3 },
            { uuid: 'reset-28', customName: 'C', accountEmail: 'c@example.com', quotaResetDay: 28 }
        ]);

        // 现在是 10-30：下次重置依次为 11-03(day 3) < 11-14 < 11-28
        const first = await manager.selectProvider('openaiResponses-custom', 'gpt-6-sol');
        const second = await manager.selectProvider('openaiResponses-custom', 'gpt-6-sol');
        expect(first.uuid).toBe('reset-3');
        expect(second.uuid).toBe('reset-3');
    });

    test('moves on to the next-soonest key when the preferred one is unhealthy', async () => {
        const manager = createManager([
            { uuid: 'reset-14', customName: 'A', quotaResetDay: 14 },
            { uuid: 'reset-3', customName: 'B', quotaResetDay: 3, isHealthy: false },
            { uuid: 'reset-28', customName: 'C', quotaResetDay: 28 }
        ]);
        const selected = await manager.selectProvider('openaiResponses-custom', 'gpt-6-sol');
        expect(selected.uuid).toBe('reset-14');
    });

    test('breaks ties by uuid and ignores ordering when some keys lack quotaResetDay', async () => {
        const tied = createManager([
            { uuid: 'b-key', customName: 'B', quotaResetDay: 14 },
            { uuid: 'a-key', customName: 'A', quotaResetDay: 14 }
        ]);
        expect((await tied.selectProvider('openaiResponses-custom', 'gpt-6-sol')).uuid).toBe('a-key');

        const mixed = createManager([
            { uuid: 'with-day', customName: 'A', quotaResetDay: 3 },
            { uuid: 'no-day', customName: 'B' }
        ]);
        const seen = new Set();
        for (let i = 0; i < 6; i++) seen.add((await mixed.selectProvider('openaiResponses-custom', 'gpt-6-sol')).uuid);
        expect(seen.has('no-day')).toBe(true);
    });
});

describe('insufficient_quota cooldown until the key quota resets', () => {
    const quotaError = (status = 429) => Object.assign(new Error('You exceeded your current quota'), {
        response: { status, data: { error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota' } } }
    });

    test('marks the key unhealthy until its next monthly reset and skips it afterwards', async () => {
        const manager = createManager([
            { uuid: 'reset-3', customName: 'B', quotaResetDay: 3 },
            { uuid: 'reset-14', customName: 'A', quotaResetDay: 14 }
        ]);

        const handled = applyProviderRateLimitCooldown({
            error: quotaError(),
            config: {},
            providerPoolManager: manager,
            providerType: 'openaiResponses-custom',
            providerUuid: 'reset-3',
            requestedModel: 'gpt-6-sol'
        });

        const exhausted = manager.providerStatus['openaiResponses-custom'].find(p => p.uuid === 'reset-3');
        expect(handled).toBe(true);
        expect(exhausted.config.isHealthy).toBe(false);
        expect(exhausted.config.scheduledRecoveryTime).toBe('2026-11-02T16:00:00.000Z'); // 上海 11-03 00:00
        expect((await manager.selectProvider('openaiResponses-custom', 'gpt-6-sol')).uuid).toBe('reset-14');
    });

    test('leaves keys without quotaResetDay on the existing 429 policy', () => {
        const manager = createManager([{ uuid: 'plain', customName: 'P' }]);
        const handled = applyProviderRateLimitCooldown({
            error: quotaError(),
            config: {},
            providerPoolManager: manager,
            providerType: 'openaiResponses-custom',
            providerUuid: 'plain',
            requestedModel: 'gpt-6-sol'
        });
        expect(handled).toBe(false);
        expect(manager.providerStatus['openaiResponses-custom'][0].config.isHealthy).not.toBe(false);
    });
});
