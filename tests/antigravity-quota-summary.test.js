import { describe, expect, jest, test } from '@jest/globals';

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    handleGeminiAntigravityOAuth: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

function createUsageService(request) {
    const service = Object.create(AntigravityApiService.prototype);
    Object.assign(service, {
        isInitialized: true,
        config: {},
        baseURLs: ['https://daily.example.test'],
        projectId: 'project-123',
        tierId: 'Antigravity Pro',
        accountEmail: 'user@example.com',
        userAgent: 'antigravity-test',
        authClient: { request },
        _applySidecar: jest.fn()
    });
    return service;
}

describe('Antigravity authoritative quota summary', () => {
    test('probes paid tier even when a project id is already configured', async () => {
        const loadResponse = {
            cloudaicompanionProject: 'project-123',
            paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
            currentTier: { id: 'free-tier', name: 'Antigravity' },
            allowedTiers: [{ id: 'free-tier', name: 'Antigravity', isDefault: true }],
            manageSubscriptionUri: 'https://example.test/?Email=ultra%40example.com'
        };
        const service = Object.create(AntigravityApiService.prototype);
        Object.assign(service, {
            projectId: 'project-123',
            tierId: null,
            accountEmail: null,
            callApi: jest.fn().mockResolvedValue(loadResponse),
            fetchAvailableModels: jest.fn().mockResolvedValue({ models: [] })
        });

        const projectId = await service.discoverProjectAndModels();

        expect(service.callApi).toHaveBeenCalledWith('loadCodeAssist', expect.objectContaining({
            cloudaicompanionProject: 'project-123'
        }));
        expect(projectId).toBe('project-123');
        expect(service.projectId).toBe('project-123');
        expect(service.tierId).toBe('Google AI Ultra');
        expect(service.accountEmail).toBe('ultra@example.com');
        expect(service.fetchAvailableModels).toHaveBeenCalledTimes(1);
    });

    test('merges retrieveUserQuotaSummary groups into the usage response', async () => {
        const quotaGroups = [
            {
                displayName: 'Gemini Models',
                buckets: [
                    {
                        bucketId: 'gemini-5h',
                        window: '5h',
                        remainingFraction: 0.75,
                        resetTime: '2026-08-06T22:01:21Z'
                    }
                ]
            }
        ];
        const request = jest.fn()
            .mockResolvedValueOnce({ data: { models: { 'gemini-3-flash': {} } } })
            .mockResolvedValueOnce({ data: { groups: quotaGroups } });
        const service = createUsageService(request);

        const result = await service.getUsageLimits();

        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][0]).toMatchObject({
            url: 'https://daily.example.test/v1internal:retrieveUserQuotaSummary',
            method: 'POST',
            body: JSON.stringify({ project: 'project-123' })
        });
        expect(result.quotaGroups).toEqual(quotaGroups);
        expect(result.models).toEqual({ 'gemini-3-flash': {} });
    });

    test('bounds both Antigravity usage requests with the configured timeout', async () => {
        const request = jest.fn()
            .mockResolvedValueOnce({ data: { models: { 'gemini-3-flash': {} } } })
            .mockResolvedValueOnce({ data: { groups: [] } });
        const service = createUsageService(request);
        service.config.ANTIGRAVITY_USAGE_TIMEOUT_MS = 1234;

        await service.getUsageLimits();

        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[0][0]).toMatchObject({ timeout: 1234 });
        expect(request.mock.calls[1][0]).toMatchObject({ timeout: 1234 });
    });

    test('keeps fetchAvailableModels usage available when quota summary lookup fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const request = jest.fn()
            .mockResolvedValueOnce({ data: { models: { 'gemini-3-flash': {} } } })
            .mockRejectedValueOnce(new Error('summary unavailable'));
        const service = createUsageService(request);

        try {
            const result = await service.getUsageLimits();

            expect(result.models).toEqual({ 'gemini-3-flash': {} });
            expect(result.quotaGroups).toBeNull();
        } finally {
            warnSpy.mockRestore();
        }
    });
});
