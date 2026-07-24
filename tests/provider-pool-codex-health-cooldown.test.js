import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

const managers = [];

function createManager(codexQuotaHealth) {
    const manager = new ProviderPoolManager({
        'openai-codex-oauth': [{
            uuid: 'codex-health-test',
            customName: 'Codex Health Test',
            isHealthy: true,
            codexQuotaHealth
        }]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            SCHEDULED_HEALTH_CHECK: {
                enabled: true,
                interval: 30 * 60 * 1000,
                providerTypes: ['openai-codex-oauth']
            }
        }
    });
    managers.push(manager);
    return manager;
}

afterEach(() => {
    jest.restoreAllMocks();
    for (const manager of managers.splice(0)) {
        if (manager.saveTimer) clearTimeout(manager.saveTimer);
    }
});

describe('Codex automatic health check quota cooldown', () => {
    test('scheduled health checks skip a provider while general quota is exhausted', async () => {
        const manager = createManager({
            general: {
                isHealthy: false,
                scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
            }
        });
        const healthCheck = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue({
            success: true,
            modelName: 'gpt-5.4'
        });

        await manager.performHealthChecks();

        expect(healthCheck).not.toHaveBeenCalled();
    });

    test('startup health checks skip exhausted general quota even without a recovery time', async () => {
        const manager = createManager({
            general: {
                isHealthy: false,
                scheduledRecoveryTime: null
            }
        });
        const healthCheck = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue({
            success: true,
            modelName: 'gpt-5.4'
        });

        await manager.performInitialHealthChecks();

        expect(healthCheck).not.toHaveBeenCalled();
    });

    test('Codex 5.3 quota exhaustion does not suppress automatic health checks', async () => {
        const manager = createManager({
            codex53: {
                isHealthy: false,
                scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
            }
        });
        const healthCheck = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue({
            success: true,
            modelName: 'gpt-5.4'
        });

        await manager.performHealthChecks();

        expect(healthCheck).toHaveBeenCalledTimes(1);
    });

    test('scheduled health checks recover expired general quota before probing', async () => {
        const manager = createManager({
            general: {
                isHealthy: false,
                scheduledRecoveryTime: '2020-01-01T00:00:00.000Z'
            }
        });
        const healthCheck = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue({
            success: true,
            modelName: 'gpt-5.4'
        });

        await manager.performHealthChecks();

        const provider = manager.providerStatus['openai-codex-oauth'][0].config;
        expect(healthCheck).toHaveBeenCalledTimes(1);
        expect(provider.codexQuotaHealth.general).toMatchObject({
            isHealthy: true,
            scheduledRecoveryTime: null
        });
    });
});
