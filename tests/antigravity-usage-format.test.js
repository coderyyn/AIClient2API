import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn()
}));

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

import { formatAntigravityUsage } from '../src/services/usage-service.js';

describe('Antigravity usage formatting', () => {
    test('collapses models with the same quota fingerprint into one shared quota item', () => {
        const formatted = formatAntigravityUsage({
            tierId: 'Antigravity Starter Quota(free)',
            account: 'user@example.com',
            models: {
                'gemini-2.5-flash': {
                    quotaInfo: { remainingFraction: 0.75, resetTime: '2026-08-11T01:00:00Z' }
                },
                'gemini-3.1-flash-image': {
                    quotaInfo: { remainingFraction: 0.75, resetTime: '2026-08-11T01:00:00Z' }
                },
                'claude-sonnet-4-6': {
                    quotaInfo: { remainingFraction: 0.5, resetTime: '2026-08-12T01:00:00Z' }
                }
            }
        });

        expect(formatted.items).toHaveLength(2);
        expect(formatted.items[0]).toMatchObject({
            label: 'Shared quota (2 models)',
            percent: 25,
            modelIds: ['gemini-2.5-flash', 'gemini-3.1-flash-image']
        });
        expect(formatted.items[1]).toMatchObject({
            label: 'gemini-claude-sonnet-4-6',
            percent: 50,
            modelIds: ['gemini-claude-sonnet-4-6']
        });
        expect(formatted.summary.usedPercent).toBe(37.5);
        expect(formatted.summary.plan).toBe('Quota(free)');
    });
});
