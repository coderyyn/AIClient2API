import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function stableProvider(providerType, provider) {
    return {
        providerType,
        uuid: String(provider.uuid || ''),
        enabled: provider.isDisabled !== true,
        checkModelName: provider.checkModelName || null,
        concurrencyLimit: Number(provider.concurrencyLimit) || 0,
        queueLimit: Number(provider.queueLimit) || 0,
        providerWeight: Number(provider.providerWeight) || 1,
        proxyId: provider.PROXY_ID || null,
        credentialHash: null,
        credentialPath: provider.CODEX_OAUTH_CREDS_FILE_PATH || provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH || null
    };
}

async function credentialHash(configRoot, configuredPath) {
    if (!configuredPath) return null;
    const relative = configuredPath.replace(/\\/g, '/').replace(/^\.\/configs\//, '').replace(/^\/+/, '');
    try { return hash(await fs.readFile(path.join(configRoot, ...relative.split('/')))); } catch { return 'missing'; }
}

function collectModelCounts(value) {
    const counts = {};
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.models && typeof node.models === 'object') {
            for (const [model, stats] of Object.entries(node.models)) {
                const count = Number(stats?.requestCount);
                if (Number.isFinite(count)) counts[model] = Math.max(counts[model] || 0, count);
            }
        }
        for (const child of Object.values(node)) visit(child);
    };
    visit(value);
    return counts;
}

export async function createRuntimeStateSnapshot(configRoot) {
    const pools = JSON.parse(await fs.readFile(path.join(configRoot, 'provider_pools.json'), 'utf8'));
    const providers = [];
    for (const providerType of Object.keys(pools).sort()) {
        for (const provider of Array.isArray(pools[providerType]) ? pools[providerType] : []) {
            const item = stableProvider(providerType, provider);
            item.credentialHash = await credentialHash(configRoot, item.credentialPath);
            delete item.credentialPath;
            providers.push(item);
        }
    }
    providers.sort((left, right) => left.providerType.localeCompare(right.providerType) || left.uuid.localeCompare(right.uuid));
    let stats = {};
    try { stats = JSON.parse(await fs.readFile(path.join(configRoot, 'model-usage-stats.json'), 'utf8')); } catch { /* optional */ }
    return {
        createdAt: new Date().toISOString(),
        providerFingerprint: hash(JSON.stringify(providers)),
        providers,
        modelCounts: collectModelCounts(stats)
    };
}

export function diffRuntimeStateSnapshots(before, after) {
    const beforeMap = new Map((before.providers || []).map(item => [`${item.providerType}:${item.uuid}`, item]));
    const afterMap = new Map((after.providers || []).map(item => [`${item.providerType}:${item.uuid}`, item]));
    const providerMutations = [];
    for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
        const left = beforeMap.get(key) || {};
        const right = afterMap.get(key) || {};
        const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
            .filter(field => field !== 'providerType' && field !== 'uuid' && JSON.stringify(left[field]) !== JSON.stringify(right[field]))
            .sort();
        if (fields.length) providerMutations.push({ providerType: right.providerType || left.providerType, uuid: right.uuid || left.uuid, fields });
    }
    const modelCountDeltas = {};
    for (const model of new Set([...Object.keys(before.modelCounts || {}), ...Object.keys(after.modelCounts || {})])) {
        const delta = Number(after.modelCounts?.[model] || 0) - Number(before.modelCounts?.[model] || 0);
        if (delta !== 0) modelCountDeltas[model] = delta;
    }
    return { providerFingerprintChanged: before.providerFingerprint !== after.providerFingerprint, providerMutations, modelCountDeltas };
}

async function main() {
    const [command, configRoot, leftPath, rightPath] = process.argv.slice(2);
    if (command === 'capture' && configRoot) {
        process.stdout.write(`${JSON.stringify(await createRuntimeStateSnapshot(configRoot), null, 2)}\n`);
        return;
    }
    if (command === 'diff' && configRoot && leftPath === undefined) throw new Error('Usage: diff <before.json> <after.json>');
    if (command === 'diff') {
        const before = JSON.parse(await fs.readFile(configRoot, 'utf8'));
        const after = JSON.parse(await fs.readFile(leftPath, 'utf8'));
        process.stdout.write(`${JSON.stringify(diffRuntimeStateSnapshots(before, after), null, 2)}\n`);
        return;
    }
    throw new Error('Usage: capture <config-root> | diff <before.json> <after.json>');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
