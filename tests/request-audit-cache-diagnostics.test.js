import { buildDiagnostics, diagnoseCacheMiss } from '../src/plugins/request-audit/cache-diagnostics.js';

function event(overrides = {}) {
  return {
    requestId: overrides.requestId || 'req-current',
    timestamp: overrides.timestamp || '2026-06-24T06:00:00.000Z',
    potluckKey: { hash: overrides.keyHash || 'sha256:key' },
    request: {
      model: overrides.model || 'gpt-5.5',
      toProvider: overrides.toProvider || 'openai-codex-oauth'
    },
    account: {
      providerUuid: overrides.accountUuid || 'account-a',
      providerNameDisplay: overrides.accountName || 'account-a'
    },
    usage: {
      promptTokens: overrides.promptTokens ?? 10000,
      cachedTokens: overrides.cachedTokens ?? 100
    },
    fingerprint: {
      payloadHash: overrides.payloadHash || 'sha256:payload-current',
      toolsHash: overrides.toolsHash || 'sha256:tools-a',
      instructionsHash: overrides.instructionsHash || 'sha256:inst-a',
      prefixHashes: overrides.prefixHashes || [{ chars: 4096, hash: 'sha256:prefix-a' }],
      sections: {
        attachments: { count: overrides.attachmentCount || 0 },
        conversation: { charLength: overrides.conversationChars || 20000 }
      }
    }
  };
}

describe('request audit cache diagnostics', () => {
  test('detects changed prefix for same key model and account', () => {
    const current = event({ prefixHashes: [{ chars: 4096, hash: 'sha256:prefix-b' }] });
    const previous = event({ requestId: 'req-prev', payloadHash: 'sha256:payload-prev', prefixHashes: [{ chars: 4096, hash: 'sha256:prefix-a' }] });

    const diagnosis = diagnoseCacheMiss(current, [previous]);

    expect(diagnosis.primaryReason).toBe('prefix_changed');
    expect(diagnosis.comparableRequestId).toBe('req-prev');
    expect(diagnosis.reasons.map(reason => reason.code)).toContain('prefix_changed');
  });

  test('detects changed tools for same key model and account', () => {
    const current = event({ toolsHash: 'sha256:tools-b' });
    const previous = event({ requestId: 'req-prev', toolsHash: 'sha256:tools-a' });

    const diagnosis = diagnoseCacheMiss(current, [previous]);

    expect(diagnosis.primaryReason).toBe('tools_changed');
  });

  test('detects account and model changes across comparable key requests', () => {
    const accountDiagnosis = diagnoseCacheMiss(event({ accountUuid: 'account-b' }), [
      event({ requestId: 'req-prev', accountUuid: 'account-a' })
    ]);
    const modelDiagnosis = diagnoseCacheMiss(event({ model: 'gpt-5.4-mini' }), [
      event({ requestId: 'req-prev', model: 'gpt-5.5' })
    ]);

    expect(accountDiagnosis.reasons.map(reason => reason.code)).toContain('account_changed');
    expect(modelDiagnosis.reasons.map(reason => reason.code)).toContain('model_changed');
  });

  test('detects short prompt or low cacheable input', () => {
    const diagnosis = diagnoseCacheMiss(event({ promptTokens: 900, cachedTokens: 0 }), []);

    expect(diagnosis.primaryReason).toBe('short_prompt_or_low_cacheable_input');
    expect(diagnosis.confidence).toBeGreaterThan(0);
  });

  test('uses unknown ttl reason when no comparable evidence exists', () => {
    const diagnosis = diagnoseCacheMiss(event(), []);

    expect(diagnosis.primaryReason).toBe('unknown_or_upstream_cache_ttl');
    expect(diagnosis.reasons.map(reason => reason.code)).toContain('unknown_or_upstream_cache_ttl');
  });

  test('builds diagnostics for low cache events only', () => {
    const low = event({ requestId: 'low', cachedTokens: 100 });
    const high = event({ requestId: 'high', cachedTokens: 8000 });
    const diagnostics = buildDiagnostics([high, low]);

    expect(diagnostics.map(item => item.requestId)).toContain('low');
    expect(diagnostics.map(item => item.requestId)).not.toContain('high');
  });
});
