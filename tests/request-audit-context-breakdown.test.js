import { buildContextBreakdown } from '../src/plugins/request-audit/context-breakdown.js';

describe('request audit context breakdown', () => {
  test('classifies OpenAI chat system tools and conversation without raw text', () => {
    const result = buildContextBreakdown({
      originalRequestBody: {
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'policy text' },
          { role: 'developer', content: 'rule text' },
          { role: 'user', content: 'hello' }
        ],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
      },
      usage: { promptTokens: 1000, cachedTokens: 120 }
    });

    expect(result.estimationMethod).toContain('calibrated');
    expect(result.sections.map(s => s.id)).toEqual(expect.arrayContaining([
      'instructions',
      'tools',
      'conversation',
      'cached_input'
    ]));
    expect(JSON.stringify(result)).not.toContain('policy text');
    expect(result.sections.find(s => s.id === 'cached_input').tokens).toBe(120);
    expect(result.sections.find(s => s.id === 'conversation').calibratedTokens).toBeGreaterThan(0);
  });

  test('classifies OpenAI responses instructions input and metadata', () => {
    const result = buildContextBreakdown({
      originalRequestBody: {
        model: 'gpt-5.5',
        instructions: 'system instructions',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'question' }] }],
        reasoning: { effort: 'high' },
        tools: [{ type: 'web_search_preview' }]
      },
      usage: { promptTokens: 500, cachedTokens: 50 }
    });

    expect(result.sections.map(s => s.id)).toEqual(expect.arrayContaining([
      'instructions',
      'tools',
      'conversation',
      'metadata',
      'cached_input'
    ]));
  });
});
