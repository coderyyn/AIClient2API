import { normalizeRpmLimit, providerRpmState, createProviderRpmError } from '../src/runtime/provider-rpm.js';
import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';
import { createCredentialManifest, fingerprintCredentialManifest } from '../src/runtime/credential-manifest.js';

test.each([-1, 1.5, NaN, Infinity, null, true, {}, '', '1.5', 'x', Number.MAX_SAFE_INTEGER + 1])('rejects invalid RPM %p', value => {
    expect(() => normalizeRpmLimit(value)).toThrow();
    expect(() => normalizeProviderConfigFields({ rpmLimit: value })).toThrow();
});
test('accepts integer config and changes the synchronized manifest fingerprint', () => {
    expect(normalizeRpmLimit()).toBe(0);
    expect(normalizeProviderConfigFields({ rpmLimit: '180' }).rpmLimit).toBe(180);
    const pools = { 'openai-codex-oauth': [{ uuid: 'a' }] };
    const old = fingerprintCredentialManifest(createCredentialManifest(pools));
    pools['openai-codex-oauth'][0].rpmLimit = 180;
    expect(fingerprintCredentialManifest(createCredentialManifest(pools))).not.toBe(old);
});
test('disabled and other providers need no Redis; enabled Codex fails closed', async () => {
    expect((await providerRpmState(null, 'openai-codex-oauth', 'a', 0)).allowed).toBe(true);
    expect((await providerRpmState(null, 'other', 'a', 180)).allowed).toBe(true);
    await expect(providerRpmState(null, 'openai-codex-oauth', 'a', 180)).rejects.toMatchObject({ status: 503, skipErrorCount: true });
});
test('local rejection has precise Retry-After and no upstream response', () => {
    const error = createProviderRpmError({ limit: 180, used: 180, retryAfterMs: 1501 });
    expect(error).toMatchObject({ status: 429, code: 'PROVIDER_RPM_LIMIT_EXCEEDED', retryAfterSeconds: 2, skipErrorCount: true });
    expect(error.response).toBeUndefined();
});


test('Redis failure remains a local 503 and never grants a permit', async () => {
    const { RedisLeaseCoordinator } = await import('../src/runtime/redis-lease-coordinator.js');
    const coordinator = new RedisLeaseCoordinator({ redis: { evalScript: async () => { throw new Error('offline'); } } });
    await expect(providerRpmState(coordinator, 'openai-codex-oauth', 'a', 180, true))
        .rejects.toMatchObject({ status: 503, origin: 'local_provider_rpm', skipErrorCount: true });
});
