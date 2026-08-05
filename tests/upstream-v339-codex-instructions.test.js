import { describe, expect, test } from '@jest/globals';
import { normalizeCodexInstructions } from '../src/providers/openai/codex-request-utils.js';

describe('Codex instruction normalization from upstream v3.3.9', () => {
    test('moves system and developer messages into top-level instructions', () => {
        const request = {
            input: [
                { role: 'system', content: 'system rule' },
                {
                    role: 'developer',
                    content: [
                        { type: 'input_text', text: 'developer rule' },
                        'developer suffix'
                    ]
                },
                { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
            ]
        };

        normalizeCodexInstructions(request);

        expect(request.instructions).toBe('system rule\ndeveloper rule\ndeveloper suffix');
        expect(request.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
        ]);
    });

    test('preserves existing instructions without duplicating identical content', () => {
        const request = {
            instructions: 'existing rule',
            input: [
                { role: 'developer', content: 'existing rule' },
                { role: 'assistant', content: 'answer' }
            ]
        };

        normalizeCodexInstructions(request);

        expect(request.instructions).toBe('existing rule');
        expect(request.input).toEqual([{ role: 'assistant', content: 'answer' }]);
    });
});
