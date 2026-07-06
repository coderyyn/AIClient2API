import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    PRICING_VERSION,
    estimateUsageCost,
    getModelPricing
} from '../src/plugins/api-potluck/cost-estimator.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pricingPath = path.join(repoRoot, 'src', 'plugins', 'api-potluck', 'pricing.json');

function readPricingFile() {
    return JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
}

describe('pricing single source', () => {
    test('shared pricing.json exists with version, prices, and aliases', () => {
        const pricing = readPricingFile();

        expect(typeof pricing.pricingVersion).toBe('string');
        expect(pricing.pricingVersion.length).toBeGreaterThan(0);
        expect(Object.keys(pricing.pricePerMillion).length).toBeGreaterThan(0);
        expect(Object.keys(pricing.modelPriceAliases).length).toBeGreaterThan(0);

        for (const [model, entry] of Object.entries(pricing.pricePerMillion)) {
            expect(typeof entry.input).toBe('number');
            expect(typeof entry.cachedInput).toBe('number');
            expect(typeof entry.output).toBe('number');
            expect(typeof entry.source).toBe('string');
            expect(model).toBe(model.trim().toLowerCase());
        }
    });

    test('cost estimator exposes the shared pricing version', () => {
        expect(PRICING_VERSION).toBe(readPricingFile().pricingVersion);
    });

    test('cost estimator prices every shared table model with shared rates', () => {
        const pricing = readPricingFile();
        for (const [model, entry] of Object.entries(pricing.pricePerMillion)) {
            const resolved = getModelPricing(model);
            // Aliased direct entries (e.g. gpt-5.1) resolve through the alias table first.
            const aliasTarget = pricing.modelPriceAliases[model];
            const expected = aliasTarget ? pricing.pricePerMillion[aliasTarget] : entry;
            expect(resolved).toMatchObject({
                input: expected.input,
                cachedInput: expected.cachedInput,
                output: expected.output
            });
        }
    });

    test('cost estimator resolves every shared alias to its priced target', () => {
        const pricing = readPricingFile();
        for (const [alias, target] of Object.entries(pricing.modelPriceAliases)) {
            const aliasPricing = getModelPricing(alias);
            const targetPricing = pricing.pricePerMillion[target];
            expect(targetPricing).toBeTruthy();
            expect(aliasPricing).toMatchObject({
                input: targetPricing.input,
                cachedInput: targetPricing.cachedInput,
                output: targetPricing.output
            });
        }
    });

    test('estimates carry the shared pricing version', () => {
        const estimate = estimateUsageCost({
            promptTokens: 1000,
            cachedTokens: 100,
            completionTokens: 100,
            totalTokens: 1100
        }, 'gpt-5.5');

        expect(estimate.pricingVersion).toBe(readPricingFile().pricingVersion);
    });
});
