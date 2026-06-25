import { describe, expect, test } from '@jest/globals';
import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';

describe('provider config normalizer', () => {
    test('normalizes Codex percentage quota limits as non-negative numbers', () => {
        const normalized = normalizeProviderConfigFields({
            codexMax5hPercent: '80',
            codexMaxWeeklyPercent: '90'
        });

        expect(normalized).toMatchObject({
            codexMax5hPercent: 80,
            codexMaxWeeklyPercent: 90
        });
    });

    test('removes legacy provider node proxy fields from saved config', () => {
        const normalized = normalizeProviderConfigFields({
            PROXY_URL: 'socks5h://127.0.0.1:11001',
            PROXY_REQUIRED: 'true',
            PROXY_ID: 'res-ip-1'
        });

        expect(normalized.PROXY_URL).toBeUndefined();
        expect(normalized.PROXY_REQUIRED).toBeUndefined();
        expect(normalized.PROXY_ID).toBe('res-ip-1');
    });
});
