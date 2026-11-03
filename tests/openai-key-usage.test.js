import { getOpenAIKeyUsage } from '../src/services/openai-key-usage.js';
import { createHash } from 'node:crypto';

test('local metadata describes reset and audit identity without credentials or fabricated balances', () => {
    const provider = { uuid: 'upstream-project-key', accountEmail: 'test@example.com', quotaResetDay: 8,
        OPENAI_API_KEY: 'secret-fixture', customName: 'test@example.com（200刀）' };
    const usage = getOpenAIKeyUsage(provider, Date.parse('2026-11-03T00:00:00Z'));
    expect(usage.summary).toMatchObject({ localUsage: true, balanceStatus: 'unsupported',
        resetAt: '2026-11-07T16:00:00.000Z',
        credentialHash: 'sha256:' + createHash('sha256').update(provider.uuid).digest('hex').slice(0, 16) });
    expect(usage.summary).not.toHaveProperty('balance');
    expect(JSON.stringify(usage)).not.toContain('secret-fixture');
    expect(getOpenAIKeyUsage({}).summary.resetAt).toBeNull();
});
