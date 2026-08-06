import { describe, expect, test } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';

describe('OpenAI Google image configuration compatibility', () => {
    test('maps extra_body.google.image_config on chat completions to Gemini imageConfig', () => {
        const converter = new OpenAIConverter();

        const request = converter.convertRequest({
            model: 'gemini-3.1-flash-image',
            messages: [{ role: 'user', content: 'draw a wide yellow banana' }],
            modalities: ['image'],
            extra_body: {
                google: {
                    image_config: { aspect_ratio: '16:9', image_size: '2K' }
                }
            }
        }, MODEL_PROTOCOL_PREFIX.GEMINI);

        expect(request.generationConfig).toMatchObject({
            responseModalities: ['IMAGE'],
            imageConfig: {
                aspectRatio: '16:9',
                imageSize: '2K'
            }
        });
    });

    test('does not treat the deprecated top-level image_config as Gemini image settings', () => {
        const converter = new OpenAIConverter();

        const request = converter.convertRequest({
            model: 'gemini-3.1-flash-image',
            messages: [{ role: 'user', content: 'draw a wide yellow banana' }],
            modalities: ['image'],
            image_config: { aspect_ratio: '1:1', image_size: '4K' }
        }, MODEL_PROTOCOL_PREFIX.GEMINI);

        expect(request.generationConfig?.imageConfig).toBeUndefined();
    });
});
