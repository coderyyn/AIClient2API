import { createHash, randomUUID } from 'node:crypto';

export const CODEX_RPM_PROVIDER = 'openai-codex-oauth';
export const RPM_ERROR = 'PROVIDER_RPM_LIMIT_EXCEEDED';

export function normalizeRpmLimit(value = 0) {
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw Object.assign(new Error('rpmLimit must be a non-negative safe integer'), {
            status: 400, code: 'INVALID_PROVIDER_RPM_LIMIT'
        });
    }
    return value;
}

export function createProviderRpmError(state) {
    const retryAfterMs = Math.max(1, Number(state.retryAfterMs) || 1000);
    return Object.assign(new Error('Provider request rate limit exceeded'), {
        status: 429, statusCode: 429, code: RPM_ERROR, origin: 'local_provider_rpm',
        skipErrorCount: true, shouldSwitchCredential: true,
        retryAfterMs, retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        details: { reason: RPM_ERROR, rpmLimit: state.limit, used: state.used }
    });
}

// Separate namespace from concurrency leases/recovery. Metadata survives idle
// window expiry; missing recent window data triggers a full safety window.
export const PROVIDER_RPM_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local root = KEYS[1] .. ':provider-rpm:'
local epoch = root .. 'epoch'
local ready = tonumber(redis.call('GET', epoch))
if not ready then
  ready = now + 60000
  redis.call('SET', epoch, ready)
end
local window = root .. ARGV[1] .. ':window'
local meta = root .. ARGV[1] .. ':last-send'
local limit = tonumber(ARGV[2])
local last = tonumber(redis.call('GET', meta))
if redis.call('EXISTS', window) == 0 and last and last > now - 60000 then
  ready = math.max(ready, now + 60000)
  redis.call('SET', epoch, ready)
  redis.call('DEL', meta)
end
redis.call('ZREMRANGEBYSCORE', window, '-inf', now - 60000)
local used = redis.call('ZCARD', window)
local wait = math.max(0, ready - now)
if used >= limit then
  -- When lowering a limit, more than one existing entry may need to expire.
  local entry = redis.call('ZRANGE', window, used - limit, used - limit, 'WITHSCORES')
  wait = math.max(wait, tonumber(entry[2]) + 60000 - now)
end
local allowed = wait <= 0
if allowed and ARGV[3] == 'consume' then
  redis.call('ZADD', window, now, ARGV[4])
  redis.call('PEXPIRE', window, 120000)
  redis.call('SET', meta, now)
  used = used + 1
end
return cjson.encode({allowed=allowed, limit=limit, used=used,
  retryAfterMs=wait, nextAvailableAt=now+wait, recovering=ready>now})
`;

export async function providerRpmState(coordinator, providerType, uuid, limit, consume = false) {
    limit = normalizeRpmLimit(limit);
    if (providerType !== CODEX_RPM_PROVIDER || !limit) {
        return { allowed: true, limit: 0, used: 0, retryAfterMs: 0, nextAvailableAt: null };
    }
    if (!uuid || !coordinator?._eval) {
        throw Object.assign(new Error('Provider RPM coordination is unavailable'), {
            status: 503, statusCode: 503, code: 'COORDINATION_UNAVAILABLE',
            origin: 'local_provider_rpm', skipErrorCount: true
        });
    }
    try {
        const hash = createHash('sha256').update(`${providerType}:${uuid}`).digest('hex');
        const value = await coordinator._eval('provider-rpm', PROVIDER_RPM_SCRIPT,
            [hash, String(limit), consume ? 'consume' : 'peek', randomUUID()]);
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) {
        error.origin = 'local_provider_rpm';
        error.skipErrorCount = true;
        throw error;
    }
}
