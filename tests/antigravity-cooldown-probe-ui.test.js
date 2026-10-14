jest.mock('../src/providers/adapter.js', () => ({ serviceInstances: {}, getServiceAdapter: jest.fn() }));
jest.mock('../src/services/usage-service.js', () => ({ usageService: { getFormattedUsage: jest.fn() } }));
jest.mock('../src/ui-modules/usage-cache.js', () => ({
    ...jest.requireActual('../src/ui-modules/usage-cache.js'), readUsageDisplayCache: jest.fn()
}));
import { handleGetUsage } from '../src/ui-modules/usage-api.js';
import { readUsageDisplayCache } from '../src/ui-modules/usage-cache.js';

test('usage page shows current recovered model despite old cached cooldown', async () => {
    const type = 'gemini-antigravity', model = 'gemini-2.5-flash';
    const healthy = { families: {}, models: { [model]: { isHealthy: true, version: 'recovery', recoversVersion: 'old', scheduledRecoveryTime: null } } };
    readUsageDisplayCache.mockResolvedValue({ providers: { [type]: { instances: [{ uuid: 'one', antigravityQuotaHealth: {
        models: { [model]: { isHealthy: false, scheduledRecoveryTime: new Date(Date.now() + 3600_000).toISOString() } }
    } }] } } });
    let body;
    const res = { writeHead: jest.fn(), end: value => { body = JSON.parse(value); } };
    await handleGetUsage({ url: '/api/usage', headers: { host: 'localhost' } }, res, {}, {
        providerPools: { [type]: [{ uuid: 'one', isHealthy: true, antigravityQuotaHealth: healthy }] }
    });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(body.providers[type].instances[0].antigravityQuotaHealth.models[model]).toEqual(healthy.models[model]);
});
