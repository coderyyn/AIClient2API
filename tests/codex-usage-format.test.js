import { describe, expect, jest, test } from '@jest/globals';
import { formatCodexUsage } from '../src/services/usage-service.js';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn()
}));

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

describe('Codex usage formatting', () => {
    test('extracts daily weekly and cumulative token usage from official usage payload', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            },
            token_usage: {
                daily: {
                    input_tokens: 1000,
                    cached_input_tokens: 400,
                    output_tokens: 200,
                    total_tokens: 1200
                },
                weekly: {
                    input_tokens: 8000,
                    cached_input_tokens: 3000,
                    output_tokens: 1000,
                    total_tokens: 9000
                },
                total: {
                    input_tokens: 50000,
                    cached_input_tokens: 20000,
                    output_tokens: 10000,
                    total_tokens: 60000
                }
            }
        });

        expect(formatted.summary.tokenUsage).toMatchObject({
            daily: { totalTokens: 1200, cachedTokens: 400 },
            weekly: { totalTokens: 9000, cachedTokens: 3000 },
            total: { totalTokens: 60000, cachedTokens: 20000 }
        });
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daily_token_usage', label: 'Daily Tokens', used: 1200, unit: 'tokens' }),
            expect.objectContaining({ id: 'weekly_token_usage', label: 'Weekly Tokens', used: 9000, unit: 'tokens' }),
            expect.objectContaining({ id: 'total_token_usage', label: 'Total Tokens', used: 60000, unit: 'tokens' })
        ]));
    });

    test('marks token usage unavailable when official Codex payload only returns quota windows', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            }
        });

        expect(formatted.summary.tokenUsage).toBeNull();
        expect(formatted.summary.tokenUsageAvailable).toBe(false);
        expect(formatted.summary.tokenUsageUnavailableReason).toBe('official_usage_token_fields_missing');
        expect(formatted.items.map(item => item.id)).not.toContain('weekly_token_usage');
        expect(formatted.items.map(item => item.id)).not.toContain('total_token_usage');
    });
});
