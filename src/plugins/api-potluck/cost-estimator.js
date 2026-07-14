import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONVERSION_MODEL = 'gemini-2.5-flash';

// Single pricing source shared with scripts/usage-ledger/daily-usage-ledger.mjs.
const PRICING_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pricing.json');
const PRICING = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));

export const PRICING_VERSION = PRICING.pricingVersion;

const PRICE_PER_MILLION = PRICING.pricePerMillion;

const MODEL_PRICE_ALIASES = PRICING.modelPriceAliases;
const MODEL_PRICE_MULTIPLIERS = PRICING.modelPriceMultipliers || {};

const GEMINI_CONVERSION_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash'
];

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeModelName(model) {
    return String(model || '').trim().toLowerCase();
}

function normalizePricedModelName(model) {
    const normalized = normalizeModelName(model);
    return MODEL_PRICE_ALIASES[normalized] || normalized;
}

function resolvePricedModel(model) {
    const normalized = normalizeModelName(model);
    const multiplierConfig = MODEL_PRICE_MULTIPLIERS[normalized];
    if (multiplierConfig?.baseModel) {
        return {
            displayModel: normalized,
            pricedModel: normalizePricedModelName(multiplierConfig.baseModel),
            multiplier: toNumber(multiplierConfig.multiplier) || 1,
            multiplierSource: multiplierConfig.source || ''
        };
    }

    const pricedModel = normalizePricedModelName(normalized);
    return {
        displayModel: pricedModel,
        pricedModel,
        multiplier: 1,
        multiplierSource: ''
    };
}

export function getConversionModels() {
    return GEMINI_CONVERSION_MODELS.map(model => ({
        model,
        pricing: PRICE_PER_MILLION[model]
    }));
}

export function normalizeConversionModel(model) {
    const normalized = normalizeModelName(model);
    return GEMINI_CONVERSION_MODELS.includes(normalized) ? normalized : DEFAULT_CONVERSION_MODEL;
}

export function getModelPricing(model) {
    return PRICE_PER_MILLION[resolvePricedModel(model).pricedModel] || null;
}

export function estimateUsageCost(usage = {}, model = DEFAULT_CONVERSION_MODEL) {
    const resolvedModel = resolvePricedModel(model);
    const pricing = getModelPricing(resolvedModel.pricedModel);
    const promptTokens = toNumber(usage.promptTokens);
    const cachedTokens = Math.min(promptTokens, toNumber(usage.cachedTokens));
    const billableInputTokens = Math.max(0, promptTokens - cachedTokens);
    const outputTokens = toNumber(usage.completionTokens);

    if (!pricing) {
        return {
            usd: 0,
            missingPriceTokens: toNumber(usage.totalTokens) || (promptTokens + outputTokens),
            model: resolvedModel.displayModel || null,
            pricingVersion: PRICING_VERSION,
            pricingSource: 'missing'
        };
    }

    const standardUsd = (
        (billableInputTokens * pricing.input) +
        (cachedTokens * pricing.cachedInput) +
        (outputTokens * pricing.output)
    ) / 1_000_000;
    const usd = standardUsd * resolvedModel.multiplier;

    return {
        usd,
        missingPriceTokens: 0,
        model: resolvedModel.displayModel,
        pricingVersion: PRICING_VERSION,
        pricingSource: resolvedModel.multiplierSource || pricing.source,
        priceMultiplier: resolvedModel.multiplier
    };
}

export function estimateActualCostFromModels(models = {}) {
    let usd = 0;
    let missingPriceTokens = 0;
    const byModel = {};

    for (const [model, usage] of Object.entries(models || {})) {
        const estimate = estimateUsageCost(usage, model);
        usd += estimate.usd;
        missingPriceTokens += estimate.missingPriceTokens;
        byModel[model] = estimate;
    }

    return {
        usd,
        missingPriceTokens,
        byModel,
        pricingVersion: PRICING_VERSION
    };
}

export function buildCost(usage = {}, models = {}, conversionModel = DEFAULT_CONVERSION_MODEL) {
    const normalizedConversionModel = normalizeConversionModel(conversionModel);
    const actual = estimateActualCostFromModels(models);
    const converted = estimateUsageCost(usage, normalizedConversionModel);

    return {
        actualUsd: actual.usd,
        convertedUsd: converted.usd,
        conversionModel: normalizedConversionModel,
        pricingVersion: PRICING_VERSION,
        missingPriceTokens: actual.missingPriceTokens,
        byModel: actual.byModel
    };
}
