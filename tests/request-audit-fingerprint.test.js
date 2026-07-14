import { buildRequestFingerprint } from '../src/plugins/request-audit/fingerprint.js';

describe('request audit fingerprint', () => {
  test('builds stable hashes for equivalent normalized payloads', () => {
    const left = buildRequestFingerprint({
      originalRequestBody: {
        model: 'gpt-5.5',
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
        input: [{ role: 'user', content: 'hello' }]
      }
    });
    const right = buildRequestFingerprint({
      originalRequestBody: {
        input: [{ content: 'hello', role: 'user' }],
        tools: [{ function: { parameters: { properties: { q: { type: 'string' } }, type: 'object' }, name: 'lookup' }, type: 'function' }],
        model: 'gpt-5.5'
      }
    });

    expect(left.payloadHash).toBe(right.payloadHash);
    expect(left.shapeHash).toBe(right.shapeHash);
    expect(left.sections.tools.hash).toBe(right.sections.tools.hash);
  });

  test('changes instruction and tool hashes when stable cache inputs change', () => {
    const base = buildRequestFingerprint({
      originalRequestBody: {
        instructions: 'always answer briefly',
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        input: 'question'
      }
    });
    const changedInstruction = buildRequestFingerprint({
      originalRequestBody: {
        instructions: 'always answer with details',
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        input: 'question'
      }
    });
    const changedTools = buildRequestFingerprint({
      originalRequestBody: {
        instructions: 'always answer briefly',
        tools: [{ type: 'function', function: { name: 'search' } }],
        input: 'question'
      }
    });

    expect(base.instructionsHash).not.toBe(changedInstruction.instructionsHash);
    expect(base.toolsHash).not.toBe(changedTools.toolsHash);
  });

  test('uses processed request body when available', () => {
    const fingerprint = buildRequestFingerprint({
      originalRequestBody: { input: 'original text' },
      processedRequestBody: { input: 'processed text' }
    });
    const processedOnly = buildRequestFingerprint({
      originalRequestBody: { input: 'processed text' }
    });

    expect(fingerprint.payloadHash).toBe(processedOnly.payloadHash);
  });

  test('does not retain raw prompt text for large payloads', () => {
    const largePrompt = `secret prompt text ${'x'.repeat(300_000)}`;
    const start = Date.now();
    const fingerprint = buildRequestFingerprint({
      originalRequestBody: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: largePrompt }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { description: 'y'.repeat(300_000) } } }]
      }
    });
    const elapsedMs = Date.now() - start;
    const serialized = JSON.stringify(fingerprint);

    expect(fingerprint.payloadHash).toMatch(/^sha256:/);
    expect(fingerprint.prefixHashes.length).toBeGreaterThan(0);
    expect(fingerprint.sections.conversation.charLength).toBeGreaterThan(0);
    expect(fingerprint.sections.tools.hash).toMatch(/^sha256:/);
    expect(serialized).not.toContain('secret prompt text');
    expect(serialized.length).toBeLessThan(8000);
    expect(elapsedMs).toBeLessThan(250);
  });
});
