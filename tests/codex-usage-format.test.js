import { describe, expect, jest, test } from '@jest/globals';
import { formatCodexUsage } from '../src/services/usage-service.js';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn()
}));

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

describe('Codex usage formatting', () => {
    function dateKey(offsetDays = 0) {
        const date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() + offsetDays);
        return date.toISOString().slice(0, 10);
    }

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
            expect.objectContaining({ id: 'daily_token_usage', label: 'Daily Tokens', used: 1200, unit: 'tokens', displayValue: '1.20k' }),
            expect.objectContaining({ id: 'weekly_token_usage', label: 'Weekly Tokens', used: 9000, unit: 'tokens', displayValue: '9.00k' }),
            expect.objectContaining({ id: 'total_token_usage', label: 'Total Tokens', used: 60000, unit: 'tokens', displayValue: '60.00k' })
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

    test('extracts account token usage from Codex CLI profile payload', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            },
            token_usage_profile: {
                stats: {
                    lifetime_tokens: 123456,
                    daily_usage_buckets: [
                        { start_date: dateKey(), tokens: 1200 },
                        { start_date: dateKey(-1), tokens: 800 },
                        { start_date: dateKey(-6), tokens: 600 },
                        { start_date: dateKey(-8), tokens: 9000 }
                    ]
                }
            }
        });

        expect(formatted.summary.tokenUsage).toMatchObject({
            daily: { totalTokens: 1200 },
            weekly: { totalTokens: 2600 },
            total: { totalTokens: 123456 }
        });
        expect(formatted.summary.tokenUsageProfile.stats.lifetime_tokens).toBe(123456);
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daily_token_usage', used: 1200, unit: 'tokens', displayValue: '1.20k' }),
            expect.objectContaining({ id: 'weekly_token_usage', used: 2600, unit: 'tokens', displayValue: '2.60k' }),
            expect.objectContaining({ id: 'total_token_usage', used: 123456, unit: 'tokens', displayValue: '123.46k' })
        ]));
    });

    test('formats large Codex token usage in billions', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            token_usage: {
                daily: { total_tokens: 999000000 },
                weekly: { total_tokens: 1000000000 },
                total: { total_tokens: 7400433719 }
            }
        });

        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daily_token_usage', used: 999000000, displayValue: '999.00M' }),
            expect.objectContaining({ id: 'weekly_token_usage', used: 1000000000, displayValue: '1.00B' }),
            expect.objectContaining({ id: 'total_token_usage', used: 7400433719, displayValue: '7.40B' })
        ]));
    });

    test('formats additional Codex Spark rate limit windows from official usage payload', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            },
            additional_rate_limits: [
                {
                    limit_name: 'GPT-5.3-Codex-Spark',
                    metered_feature: 'codex_bengalfox',
                    rate_limit: {
                        primary_window: { used_percent: 12, reset_at: 1780100000 },
                        secondary_window: { used_percent: 34, reset_at: 1780600000 }
                    }
                }
            ]
        });

        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'additional_gpt_5_3_codex_spark_primary_window',
                label: 'GPT-5.3-Codex-Spark (5h)',
                used: 12,
                unit: 'percent'
            }),
            expect.objectContaining({
                id: 'additional_gpt_5_3_codex_spark_secondary_window',
                label: 'GPT-5.3-Codex-Spark (Weekly)',
                used: 34,
                unit: 'percent'
            })
        ]));
    });
});
