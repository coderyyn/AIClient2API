import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['test']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

describe('provider refresh fencing', () => {
    afterEach(() => jest.clearAllMocks());

    test('does not refresh when another worker owns the refresh lock', async () => {
        const coordination = { acquireRefreshFence: jest.fn(async () => null) };
        const manager = new ProviderPoolManager({ test: [{ uuid: 'one' }] }, {
            coordination,
            persistenceEnabled: false
        });
        await expect(manager._refreshNodeToken('test', manager.providerStatus.test[0], true)).resolves.toBe(false);
        expect(coordination.acquireRefreshFence).toHaveBeenCalled();
    });

    test('validates the fencing token before accepting refreshed state', async () => {
        const coordination = {
            acquireRefreshFence: jest.fn(async () => 7),
            validateRefreshFence: jest.fn(async () => false),
            releaseRefreshFence: jest.fn(async () => true)
        };
        const serviceAdapterFactory = jest.fn(() => ({
            refreshToken: jest.fn(async () => true),
            forceRefreshToken: jest.fn(async () => true)
        }));
        const manager = new ProviderPoolManager({ test: [{ uuid: 'one' }] }, {
            coordination,
            persistenceEnabled: false,
            serviceAdapterFactory
        });
        const status = manager.providerStatus.test[0];

        await expect(manager._refreshNodeToken('test', status, true)).rejects.toMatchObject({ code: 'STALE_REFRESH_FENCE' });
        expect(status.config.lastRefreshTime).toBeFalsy();
        expect(coordination.releaseRefreshFence).toHaveBeenCalledWith('test', 'one', 7);
    });
});
