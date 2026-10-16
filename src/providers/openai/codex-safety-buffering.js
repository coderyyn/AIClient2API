// Persist only the two allowlisted signals, never the full upstream headers.
export function normalizeCodexSafetyBuffering(value) {
    const enabled = typeof value?.enabled === 'boolean' ? value.enabled : null;
    const model = typeof value?.fasterModel === 'string' ? value.fasterModel.trim() : '';
    return { enabled, fasterModel: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model) ? model : null };
}

export function parseCodexSafetyBuffering(headers) {
    const read = name => {
        if (typeof headers?.get === 'function') return headers.get(name);
        const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name);
        return key ? headers[key] : undefined;
    };
    const raw = read('x-codex-safety-buffering-enabled');
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    return normalizeCodexSafetyBuffering({
        enabled: text === true || text === 'true' ? true : text === false || text === 'false' ? false : null,
        fasterModel: read('x-codex-safety-buffering-faster-model')
    });
}
