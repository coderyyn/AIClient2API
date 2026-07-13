import { describe, expect, test } from '@jest/globals';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';

describe('Codex tool name normalization', () => {
    test('maps image_gen.imagegen to an upstream-safe name and preserves the reverse mapping', () => {
        const converter = new CodexConverter();
        const requestId = 'imagegen-tool-request';
        const tools = [{
            type: 'function',
            name: 'image_gen.imagegen',
            description: 'Generate image',
            parameters: { type: 'object', properties: {} }
        }];

        converter.buildToolNameMap(tools, requestId);
        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].name).toBe('image_gen__imagegen');
        expect(converter.getOriginalToolName('image_gen__imagegen', requestId)).toBe('image_gen.imagegen');
    });

    test('keeps the already safe image_gen__imagegen name unchanged', () => {
        const converter = new CodexConverter();
        const requestId = 'safe-imagegen-tool-request';
        const tools = [{
            type: 'function',
            function: {
                name: 'image_gen__imagegen',
                description: 'Generate image',
                parameters: { type: 'object', properties: {} }
            }
        }];

        converter.buildToolNameMap(tools, requestId);
        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].name).toBe('image_gen__imagegen');
        expect(converter.getOriginalToolName('image_gen__imagegen', requestId)).toBe('image_gen__imagegen');
    });
});
