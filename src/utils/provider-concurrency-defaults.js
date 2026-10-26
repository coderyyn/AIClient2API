export function applyNewProviderConcurrencyDefaults(providerType, config) {
    if (providerType !== 'gemini-antigravity') return config;
    const result = { ...config };
    for (const field of ['concurrencyLimit', 'queueLimit']) {
        if (result[field] === undefined || result[field] === null || result[field] === '') result[field] = 15;
    }
    return result;
}
