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
});
