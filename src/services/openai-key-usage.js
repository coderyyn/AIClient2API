import { createHash } from 'node:crypto';
import { getNextQuotaResetTime } from '../utils/quota-reset-time.js';

// API project keys expose no documented credit-balance endpoint. This payload
// describes local accounting capabilities and never queries the upstream.
export function getOpenAIKeyUsage(provider = {}, now = Date.now()) {
    const resetAt = getNextQuotaResetTime(provider.quotaResetDay, provider.quotaResetTimezone, now);
    return {
        source: 'local',
        updatedAt: new Date(now).toISOString(),
        user: { label: provider.accountEmail || '' },
        summary: { localUsage: true, balanceStatus: 'unsupported', quotaResetDay: provider.quotaResetDay || null,
            resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
            credentialHash: provider.uuid ? `sha256:${createHash('sha256').update(provider.uuid).digest('hex').slice(0, 16)}` : null },
        items: []
    };
}
