import { existsSync, readFileSync } from 'fs';
import { CONFIG } from '../core/config-manager.js';

// Control-worker mutations share this queue. Unlike a timed lock, it never
// releases ownership while an asynchronous persistence operation is still running.
let mutationTail = Promise.resolve();
export function withCredentialLifecycleLock(operation) {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
}

export function assertRoutingNotArchived(routing, pools = null) {
    const uuids = routing.routingMode === 'fixed'
        ? [routing.fixedCredential?.uuid]
        : routing.routingMode === 'restricted' ? routing.restrictedCredentialUuids || [] : [];
    if (!uuids.some(Boolean)) return;
    if (!pools) {
        const file = CONFIG.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        pools = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : (CONFIG.providerPools || {});
    }
    for (const [type, providers] of Object.entries(pools)) {
        for (const provider of providers || []) {
            if (provider.isArchived && uuids.includes(provider.uuid)
                && (routing.routingMode !== 'fixed' || !routing.fixedCredential?.providerType || routing.fixedCredential.providerType === type)) {
                throw Object.assign(new Error('凭据已归档，请先恢复后再绑定'), { code: 'CREDENTIAL_ARCHIVED', status: 409 });
            }
        }
    }
}

export function buildArchiveUpdate(providers, uuids, action, bindings = [], now = new Date().toISOString()) {
    if (!['archive', 'restore'].includes(action) || !Array.isArray(uuids) || !uuids.length
        || uuids.some(uuid => typeof uuid !== 'string' || !uuid) || new Set(uuids).size !== uuids.length) {
        throw Object.assign(new Error('请选择不同的凭据并指定归档或恢复操作'), { status: 400 });
    }
    const missing = uuids.filter(uuid => !providers.some(provider => provider.uuid === uuid));
    if (missing.length) throw Object.assign(new Error('部分凭据不存在，请刷新列表'), { status: 404 });
    const conflicts = action === 'archive' ? bindings.filter(binding => uuids.includes(binding.uuid)) : [];
    if (conflicts.length) throw Object.assign(new Error('请先解除关联 Key 的凭据绑定，再归档'), { status: 409, conflicts });
    return providers.map(provider => {
        if (!uuids.includes(provider.uuid)) return provider;
        if (action === 'restore' && !provider.isArchived) return provider;
        return { ...provider, isArchived: action === 'archive',
            archivedAt: action === 'archive' ? provider.archivedAt || now : null, isDisabled: true };
    });
}
