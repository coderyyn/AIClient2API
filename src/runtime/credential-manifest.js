import { createHash } from 'crypto';

function normalizedList(value) {
    return Array.isArray(value)
        ? [...new Set(value.map(item => String(item)))].sort()
        : [];
}

function normalizedInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function createCredentialManifest(providerPools = {}) {
    const manifest = [];
    for (const providerType of Object.keys(providerPools).sort()) {
        const providers = Array.isArray(providerPools[providerType]) ? providerPools[providerType] : [];
        for (const provider of providers) {
            manifest.push({
                providerType,
                uuid: String(provider?.uuid || ''),
                enabled: provider?.isDisabled !== true,
                supportedModels: normalizedList(provider?.supportedModels),
                notSupportedModels: normalizedList(provider?.notSupportedModels),
                concurrencyLimit: normalizedInteger(provider?.concurrencyLimit),
                queueLimit: normalizedInteger(provider?.queueLimit),
                weight: Number.isFinite(Number(provider?.providerWeight)) && Number(provider.providerWeight) > 0
                    ? Number(provider.providerWeight)
                    : 1
            });
        }
    }
    return manifest.sort((left, right) => {
        const typeOrder = left.providerType.localeCompare(right.providerType);
        return typeOrder || left.uuid.localeCompare(right.uuid);
    });
}

export function fingerprintCredentialManifest(manifest) {
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

