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

    test('adds authoritative 5h and weekly remaining quota items from quota groups', () => {
        const formatted = formatAntigravityUsage({
            tierId: 'Antigravity Pro',
            account: 'user@example.com',
            models: {
                'gemini-3-flash': {
                    quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-06T22:00:00Z' }
                }
            },
            quotaGroups: [
                {
                    displayName: 'Gemini Models',
                    buckets: [
                        {
                            bucketId: 'gemini-weekly',
                            displayName: 'Weekly Limit Remaining',
                            window: 'weekly',
                            remainingFraction: 0.9,
                            resetTime: '2026-08-11T04:53:25Z'
                        },
                        {
                            bucketId: 'gemini-5h',
                            displayName: 'Five Hour Limit Remaining',
                            window: '5h',
                            remainingFraction: 0.75,
                            resetTime: '2026-08-06T22:01:21Z'
                        }
                    ]
                },
                {
                    displayName: 'Claude and GPT models',
                    buckets: [
                        {
                            bucketId: '3p-weekly',
                            displayName: 'Weekly Limit Remaining',
                            window: 'weekly',
                            remainingFraction: 1,
                            resetTime: '2026-08-13T17:01:21Z'
                        }
                    ]
                }
            ]
        });

        const authoritativeItems = formatted.items.filter(item => item.source === 'retrieveUserQuotaSummary');
        expect(authoritativeItems).toHaveLength(3);
        expect(authoritativeItems).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'quota-group:gemini-5h',
                label: 'Gemini Models · Five Hour Limit Remaining',
                percent: 25,
                remainingPercent: 75,
                displayValue: '75.0%',
                windowKind: 'short',
                resetAt: '2026-08-06T22:01:21.000Z'
            }),
            expect.objectContaining({
                id: 'quota-group:gemini-weekly',
                label: 'Gemini Models · Weekly Limit Remaining',
                percent: 10,
                remainingPercent: 90,
                displayValue: '90.0%',
                windowKind: 'weekly'
            }),
            expect.objectContaining({
                id: 'quota-group:3p-weekly',
                label: 'Claude and GPT models · Weekly Limit Remaining',
                percent: 0,
                remainingPercent: 100,
                displayValue: '100.0%',
                windowKind: 'weekly'
            })
        ]));
        expect(formatted.items.some(item => item.id === 'gemini-3-flash')).toBe(true);
    });
});
