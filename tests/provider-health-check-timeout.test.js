import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

const managers = [];

function createManager(generateContent) {
    const serviceAdapterFactory = jest.fn(() => ({ generateContent }));
    const manager = new ProviderPoolManager({
        'gemini-antigravity': [{ uuid: 'health-one', checkModelName: 'gemini-3.1-flash-lite' }]
    }, {
        logLevel: 'error',
        serviceAdapterFactory,
        globalConfig: {},
        saveDebounceTime: 60_000
    });
    managers.push(manager);
    return { manager, serviceAdapterFactory };
}

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
    for (const manager of managers.splice(0)) {
        if (manager.saveTimer) clearTimeout(manager.saveTimer);
        if (manager.stateEventTimer) clearTimeout(manager.stateEventTimer);
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('provider health check timeout and de-duplication', () => {
    test('returns a timeout result after the hard 60 second deadline', async () => {
        const generateContent = jest.fn(() => new Promise(() => {}));
        const { manager, serviceAdapterFactory } = createManager(generateContent);
        const promise = manager._checkProviderHealth('gemini-antigravity', {
            uuid: 'health-one',
            checkModelName: 'gemini-3.1-flash-lite'
        });

        await jest.advanceTimersByTimeAsync(60_000);

        await expect(promise).resolves.toMatchObject({
            success: false,
            modelName: 'gemini-3.1-flash-lite',
            errorMessage: expect.stringMatching(/timed out after 60000ms/i)
        });
        expect(serviceAdapterFactory).toHaveBeenCalledWith(expect.objectContaining({
            HEALTH_CHECK_REQUEST_TIMEOUT_MS: 60_000
        }));
    });

    test('reuses the in-flight result for duplicate checks of the same credential', async () => {
        let resolveRequest;
        const generateContent = jest.fn(() => new Promise(resolve => { resolveRequest = resolve; }));
        const { manager } = createManager(generateContent);
        const config = { uuid: 'health-one', checkModelName: 'gemini-3.1-flash-lite' };

        const first = manager._checkProviderHealth('gemini-antigravity', config);
        const second = manager._checkProviderHealth('gemini-antigravity', config);
        expect(generateContent).toHaveBeenCalledTimes(1);

        resolveRequest({ ok: true });
        await expect(first).resolves.toMatchObject({ success: true });
        await expect(second).resolves.toMatchObject({ success: true, reused: true });
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    test('keeps a timed-out upstream check guarded so an immediate retry does not hit upstream again', async () => {
        const generateContent = jest.fn(() => new Promise(() => {}));
        const { manager } = createManager(generateContent);
        const config = { uuid: 'health-one', checkModelName: 'gemini-3.1-flash-lite' };
        const first = manager._checkProviderHealth('gemini-antigravity', config);

        await jest.advanceTimersByTimeAsync(60_000);
        await expect(first).resolves.toMatchObject({ success: false, timedOut: true });

        await expect(manager._checkProviderHealth('gemini-antigravity', config)).resolves.toMatchObject({
            success: false,
            timedOut: true,
            reused: true
        });
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    test('marks a duplicate factory failure as reused instead of exposing two owner failures', async () => {
        const serviceAdapterFactory = jest.fn(() => { throw new Error('adapter init failed'); });
        const manager = new ProviderPoolManager({
            'gemini-antigravity': [{ uuid: 'health-one', checkModelName: 'gemini-3.1-flash-lite' }]
        }, { logLevel: 'error', serviceAdapterFactory, saveDebounceTime: 60_000 });
        managers.push(manager);
        const config = { uuid: 'health-one', checkModelName: 'gemini-3.1-flash-lite' };

        const first = manager._checkProviderHealth('gemini-antigravity', config);
        const second = manager._checkProviderHealth('gemini-antigravity', config);

        await expect(first).resolves.toMatchObject({ success: false, errorMessage: 'adapter init failed' });
        await expect(second).resolves.toMatchObject({ success: false, errorMessage: 'adapter init failed', reused: true });
        expect(serviceAdapterFactory).toHaveBeenCalledTimes(1);
    });
});


test('local Codex RPM refusal skips checks without unhealthy state or format retries', async () => {
    const type = 'openai-codex-oauth';
    const generateContent = jest.fn(async () => { throw Object.assign(new Error('local RPM'), {
        origin: 'local_provider_rpm', code: 'PROVIDER_RPM_LIMIT_EXCEEDED', status: 429, retryAfterMs: 1000
    }); });
    const config = { uuid: 'rpm-health', isHealthy: true, checkHealth: true, checkModelName: 'gpt-6-sol' };
    const manager = new ProviderPoolManager({ [type]: [config] }, {
        persistenceEnabled: false, logLevel: 'error', serviceAdapterFactory: () => ({ generateContent }),
        globalConfig: { SCHEDULED_HEALTH_CHECK: { enabled: true, providerTypes: [type] } }
    });
    managers.push(manager);
    jest.spyOn(manager, '_buildHealthCheckRequests').mockReturnValue([{ input: 'health' }]);
    const mark = jest.spyOn(manager, 'markProviderHealthCheckFailed');
    expect(await manager._checkProviderHealth(type, config)).toEqual(expect.objectContaining({ skipped: true, success: false }));
    expect(generateContent).toHaveBeenCalledTimes(1);
    await manager.performInitialHealthChecks();
    await manager.performHealthChecks();
    expect(mark).not.toHaveBeenCalled();
    expect(manager.providerStatus[type][0].config.isHealthy).toBe(true);
});
