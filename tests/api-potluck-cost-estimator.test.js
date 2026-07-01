import { describe, expect, test } from '@jest/globals';

import {
    buildCost,
    estimateUsageCost,
    getConversionModels,
    normalizeConversionModel
} from '../src/plugins/api-potluck/cost-estimator.js';

describe('api potluck cost estimator', () => {
    test('uses standard official defaults for codex actual cost and gemini conversion cost', () => {
        const usage = {
            promptTokens: 1000000,
            cachedTokens: 200000,
            completionTokens: 100000,
            totalTokens: 1100000
        };
        const cost = buildCost(usage, { 'gpt-5.4-mini': usage }, 'gemini-2.5-flash');

        expect(cost.actualUsd).toBeCloseTo(1.065, 6);
        expect(cost.convertedUsd).toBeCloseTo(0.496, 6);
        expect(cost.conversionModel).toBe('gemini-2.5-flash');
        expect(cost.pricingVersion).toBe('official-2026-07-01');
        expect(cost.missingPriceTokens).toBe(0);
    });

    test('only allows gemini conversion models from 2.5 flash-lite through 3.5 flash', () => {
        expect(getConversionModels().map(item => item.model)).toEqual([
            'gemini-2.5-flash-lite',
            'gemini-2.5-flash',
            'gemini-3-flash',
            'gemini-3.1-flash-lite',
            'gemini-3.5-flash'
        ]);
        expect(normalizeConversionModel('gpt-5.4-mini')).toBe('gemini-2.5-flash');
        expect(normalizeConversionModel('gemini-3.5-flash')).toBe('gemini-3.5-flash');
    });

    test('tracks missing actual model price without blocking selected gemini conversion', () => {
        const usage = {
            promptTokens: 1000,
            cachedTokens: 0,
            completionTokens: 500,
            totalTokens: 1500
        };
        const cost = buildCost(usage, { 'custom-model': usage }, 'gemini-2.5-flash-lite');

        expect(cost.actualUsd).toBe(0);
        expect(cost.missingPriceTokens).toBe(1500);
        expect(cost.convertedUsd).toBeCloseTo(0.0003, 8);
    });
});
