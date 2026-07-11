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
        expect(cost.pricingVersion).toBe('official-2026-07-12-r1');
        expect(cost.missingPriceTokens).toBe(0);
    });

    test('prices cached input tokens with cached input rates instead of full input rates', () => {
        const usage = {
            promptTokens: 1000000,
            cachedTokens: 600000,
            completionTokens: 300000,
            reasoningTokens: 100000,
            totalTokens: 1300000
        };

        const cost = estimateUsageCost(usage, 'gpt-5.4-mini');

        expect(cost.usd).toBeCloseTo(((400000 * 0.75) + (600000 * 0.075) + (300000 * 4.50)) / 1000000, 8);
    });

    test('prices gpt 5.3 codex spark with the gpt 5.4 mini temporary rate', () => {
        const usage = {
            promptTokens: 1000000,
            cachedTokens: 600000,
            completionTokens: 300000,
            reasoningTokens: 100000,
            totalTokens: 1300000
        };

        const spark = estimateUsageCost(usage, 'gpt-5.3-codex-spark');
        const mini = estimateUsageCost(usage, 'gpt-5.4-mini');

        expect(spark.usd).toBeCloseTo(mini.usd, 8);
        expect(spark.pricingSource).toBe('temporary:gpt-5.4-mini');
    });

    test('prices gpt image 2 image tokens from the official image generation rates', () => {
        const usage = {
            promptTokens: 1000000,
            cachedTokens: 250000,
            completionTokens: 100000,
            totalTokens: 1100000
        };

        const cost = estimateUsageCost(usage, 'gpt-image-2');

        expect(cost.usd).toBeCloseTo(((750000 * 8.00) + (250000 * 2.00) + (100000 * 30.00)) / 1000000, 8);
        expect(cost.missingPriceTokens).toBe(0);
        expect(cost.pricingSource).toBe('official');
    });

    test('normalizes historical model aliases before pricing', () => {
        const usage = {
            promptTokens: 1000,
            cachedTokens: 100,
            completionTokens: 100,
            totalTokens: 1100
        };

        const spark = estimateUsageCost(usage, 'gpt-5.3-codex-spark');
        const compactGpt55 = estimateUsageCost(usage, 'gpt5.5');
        const gpt55 = estimateUsageCost(usage, 'gpt-5.5');
        const typoGpt51 = estimateUsageCost(usage, 'gtp-5.1');
        const nonexistentGpt51 = estimateUsageCost(usage, 'gpt-5.1');
        const nonexistentGpt5 = estimateUsageCost(usage, 'gpt-5');
        const bareGpt54 = estimateUsageCost(usage, '5.4');
        const bareGpt55 = estimateUsageCost(usage, '5.5');
        const bareGpt56 = estimateUsageCost(usage, 'gpt-5.6');

        expect(compactGpt55).toMatchObject({
            model: 'gpt-5.5',
            missingPriceTokens: 0
        });
        expect(compactGpt55.usd).toBeCloseTo(gpt55.usd, 8);
        expect(typoGpt51).toMatchObject({
            model: 'gpt-5.3-codex-spark',
            missingPriceTokens: 0
        });
        expect(typoGpt51.usd).toBeCloseTo(spark.usd, 8);
        for (const estimate of [nonexistentGpt51, nonexistentGpt5, bareGpt54, bareGpt55]) {
            expect(estimate).toMatchObject({
                model: 'gpt-5.3-codex-spark',
                missingPriceTokens: 0
            });
            expect(estimate.usd).toBeCloseTo(spark.usd, 8);
        }
        expect(bareGpt56).toMatchObject({
            model: 'gpt-5.6',
            usd: 0,
            missingPriceTokens: 1100
        });
    });

    test('prices official Codex fast modes with their fast credit multipliers', () => {
        const usage = {
            promptTokens: 1000,
            cachedTokens: 100,
            completionTokens: 100,
            totalTokens: 1100
        };

        const gpt55 = estimateUsageCost(usage, 'gpt-5.5');
        const gpt55Fast = estimateUsageCost(usage, 'gpt-5.5-fast');
        const gpt56Sol = estimateUsageCost(usage, 'gpt-5.6-sol');
        const gpt56SolFast = estimateUsageCost(usage, 'gpt-5.6-sol-fast');
        const gpt54 = estimateUsageCost(usage, 'gpt-5.4');
        const gpt54Fast = estimateUsageCost(usage, 'gpt-5.4-fast');

        expect(gpt56SolFast).toMatchObject({
            model: 'gpt-5.6-sol-fast',
            missingPriceTokens: 0,
            priceMultiplier: 2.5,
            pricingSource: 'temporary:codex-fast-assumed'
        });
        expect(gpt56SolFast.usd).toBeCloseTo(gpt56Sol.usd * 2.5, 8);
        expect(gpt55Fast).toMatchObject({
            model: 'gpt-5.5-fast',
            missingPriceTokens: 0,
            priceMultiplier: 2.5
        });
        expect(gpt55Fast.usd).toBeCloseTo(gpt55.usd * 2.5, 8);
        expect(gpt54Fast).toMatchObject({
            model: 'gpt-5.4-fast',
            missingPriceTokens: 0,
            priceMultiplier: 2
        });
        expect(gpt54Fast.usd).toBeCloseTo(gpt54.usd * 2, 8);
    });

    test('prices historical Codex fast model names without leaving missing tokens', () => {
        const usage = {
            promptTokens: 1000,
            cachedTokens: 100,
            completionTokens: 100,
            totalTokens: 1100
        };
        const cases = [
            ['gpt-5.4-mini-fast', 'gpt-5.4-mini', 2],
            ['gpt-5.3-codex-spark-fast', 'gpt-5.3-codex-spark', 1],
            ['gpt-5.3-codex-fast', 'gpt-5.3-codex', 1],
            ['gpt-5.2-fast', 'gpt-5.2', 1],
            ['gpt-image-2-fast', 'gpt-image-2', 1]
        ];

        for (const [fastModel, baseModel, multiplier] of cases) {
            const base = estimateUsageCost(usage, baseModel);
            const fast = estimateUsageCost(usage, fastModel);
            expect(fast).toMatchObject({
                model: fastModel,
                missingPriceTokens: 0,
                priceMultiplier: multiplier
            });
            expect(fast.usd).toBeCloseTo(base.usd * multiplier, 8);
        }
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
