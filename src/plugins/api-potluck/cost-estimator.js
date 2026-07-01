export const DEFAULT_CONVERSION_MODEL = 'gemini-2.5-flash';

export const PRICING_VERSION = 'official-2026-07-01';

const PRICE_PER_MILLION = {
    'gpt-5.5': { input: 5.00, cachedInput: 0.50, output: 30.00, provider: 'openai', source: 'official' },
    'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00, provider: 'openai', source: 'official' },
    'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50, provider: 'openai', source: 'official' },
    'gpt-5.4-nano': { input: 0.20, cachedInput: 0.02, output: 1.25, provider: 'openai', source: 'official' },
    'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.00, provider: 'openai', source: 'official' },
    'gpt-5.3-codex-spark': { input: 0.75, cachedInput: 0.075, output: 4.50, provider: 'openai', source: 'temporary:gpt-5.4-mini' },
    'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.00, provider: 'openai', source: 'legacy:current-gpt-5.3-codex' },
    'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10.00, provider: 'openai', source: 'legacy:snapshot' },
    'gpt-image-2': { input: 8.00, cachedInput: 2.00, output: 30.00, provider: 'openai', source: 'official' },

    'gemini-2.5-flash-lite': { input: 0.10, cachedInput: 0.01, output: 0.40, provider: 'gemini', source: 'official' },
    'gemini-2.5-flash': { input: 0.30, cachedInput: 0.03, output: 2.50, provider: 'gemini', source: 'official' },
    'gemini-3-flash': { input: 0.50, cachedInput: 0.05, output: 3.00, provider: 'gemini', source: 'official' },
    'gemini-3-flash-preview': { input: 0.50, cachedInput: 0.05, output: 3.00, provider: 'gemini', source: 'official' },
    'gemini-3.1-flash-lite': { input: 0.25, cachedInput: 0.025, output: 1.50, provider: 'gemini', source: 'official' },
    'gemini-3.5-flash': { input: 1.50, cachedInput: 0.15, output: 9.00, provider: 'gemini', source: 'official' }
};

const MODEL_PRICE_ALIASES = {
    'codex-auto-review': 'gpt-5.5',
    'gpt5.5': 'gpt-5.5',
    'gpt-5.4-fast': 'gpt-5.4',
    'gpt-5.4-mini-fast': 'gpt-5.4-mini',
    'gpt-5.3-codex-spark-fast': 'gpt-5.3-codex-spark',
    'gpt-5.3codexspark': 'gpt-5.3-codex-spark',
    'gtp-5.1': 'gpt-5.3-codex-spark',
    'gpt-5.1': 'gpt-5.3-codex-spark',
    'gpt-5': 'gpt-5.3-codex-spark',
    '5.4': 'gpt-5.3-codex-spark',
    '5.5': 'gpt-5.3-codex-spark'
};

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
    return PRICE_PER_MILLION[normalizePricedModelName(model)] || null;
}

export function estimateUsageCost(usage = {}, model = DEFAULT_CONVERSION_MODEL) {
    const normalizedModel = normalizePricedModelName(model);
    const pricing = getModelPricing(normalizedModel);
    const promptTokens = toNumber(usage.promptTokens);
    const cachedTokens = Math.min(promptTokens, toNumber(usage.cachedTokens));
    const billableInputTokens = Math.max(0, promptTokens - cachedTokens);
    const outputTokens = toNumber(usage.completionTokens) + toNumber(usage.reasoningTokens);

    if (!pricing) {
        return {
            usd: 0,
            missingPriceTokens: toNumber(usage.totalTokens) || (promptTokens + outputTokens),
            model: normalizedModel || null,
            pricingVersion: PRICING_VERSION,
            pricingSource: 'missing'
        };
    }

    const usd = (
        (billableInputTokens * pricing.input) +
        (cachedTokens * pricing.cachedInput) +
        (outputTokens * pricing.output)
    ) / 1_000_000;

    return {
        usd,
        missingPriceTokens: 0,
        model: normalizedModel,
        pricingVersion: PRICING_VERSION,
        pricingSource: pricing.source
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
