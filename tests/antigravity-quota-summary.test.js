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
