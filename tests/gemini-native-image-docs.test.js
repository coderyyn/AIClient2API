import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from '@jest/globals';
import { API_EXAMPLES, API_GUIDE_DATA, formatApiGuideText } from '../src/utils/docs-data.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = path.join(repoRoot, 'docs', 'gemini-native-image-api.md');

describe('Gemini native Banana2 documentation contract', () => {
    test('publishes native image generation and multi-image editing examples through /api/example data', () => {
        const routes = API_GUIDE_DATA.flatMap(group => group.routes);
        const nativeRoute = routes.find(route => route.path === '/v1beta/models/{model}:generateContent');

        expect(nativeRoute?.desc).toContain('图片');
        expect(API_EXAMPLES).toHaveProperty('gemini_native_image');
        expect(API_EXAMPLES.gemini_native_image).toContain('gemini-3.1-flash-image:generateContent?key=YOUR_API_KEY');
        expect(API_EXAMPLES.gemini_native_image).toContain('responseModalities');
        expect(API_EXAMPLES.gemini_native_image).toContain('imageConfig');
        expect(API_EXAMPLES.gemini_native_image).toContain('inlineData');
        expect(API_EXAMPLES.gemini_native_image).not.toContain('size:');
        expect(API_EXAMPLES.gemini_native_image).not.toContain('extra_body');

        const textGuide = formatApiGuideText();
        expect(textGuide).toContain('Gemini 原生图片生成与多图编辑');
        expect(textGuide).toContain('gemini-3.1-flash-image:generateContent?key=YOUR_API_KEY');
    });

    test('documents the complete Gemini request and response contract without real credentials', () => {
        expect(fs.existsSync(guidePath)).toBe(true);
        const guide = fs.readFileSync(guidePath, 'utf8');

        expect(guide).toContain('/v1beta/models/gemini-3.1-flash-image:generateContent?key=YOUR_API_KEY');
        expect(guide).toContain('/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent');
        expect(guide).toContain('"aspectRatio": "16:9"');
        expect(guide).toContain('"imageSize": "2K"');
        expect((guide.match(/"inlineData"/g) || []).length).toBeGreaterThanOrEqual(2);
        expect(guide).toContain('candidates[].content.parts[].inlineData');
        expect(guide).toContain('`size: "1536x1024"`');
        expect(guide).not.toMatch(/maki_[A-Za-z0-9_-]+|gcli_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}/);
    });
});
