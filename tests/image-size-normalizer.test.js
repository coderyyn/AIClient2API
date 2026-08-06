import { jest } from '@jest/globals';
import sharp from 'sharp';
import {
    ImageAspectRatioMismatchError,
    appendAspectRatioConstraint,
    calculateAspectDeviation,
    normalizeImageBuffer,
    parseRequestedImageSize
} from '../src/utils/image-size-normalizer.js';

describe('image size parsing and prompt constraints', () => {
    test('parses an explicit image size within configured limits', () => {
        expect(parseRequestedImageSize('1536x1024', { maxPixels: 8_388_608 })).toEqual({
            width: 1536,
            height: 1024,
            text: '1536x1024',
            aspectWidth: 3,
            aspectHeight: 2
        });
    });

    test.each([undefined, null, '', 'auto'])('does not normalize an omitted or automatic size: %p', (size) => {
        expect(parseRequestedImageSize(size)).toBeNull();
    });

    test('rejects an oversized requested image with a Chinese message', () => {
        expect(() => parseRequestedImageSize('4096x4096', { maxPixels: 8_388_608 })).toThrow(
            '请求的图片尺寸过大'
        );
    });

    test('appends only an aspect-ratio constraint and preserves the original prompt', () => {
        const original = '清晨的海边公路';
        const result = appendAspectRatioConstraint(original, '1536x1024');

        expect(result.originalPrompt).toBe(original);
        expect(result.promptConstraintApplied).toBe(true);
        expect(result.prompt).toContain('[ASPECT RATIO]');
        expect(result.prompt.endsWith('[ASPECT RATIO] Strict 3:2')).toBe(true);
        expect(result.prompt).not.toContain('Preserve every requested subject');
        expect(result.prompt).not.toContain('1536×1024');
        expect(result.prompt).not.toContain('1536x1024');
    });
});

describe('image aspect deviation and normalization', () => {
    test('calculates the symmetric aspect-ratio deviation', () => {
        expect(calculateAspectDeviation(1277, 1232, 1024, 1024)).toBeCloseTo(0.03523884, 6);
        expect(calculateAspectDeviation(1903, 826, 1536, 1024)).toBeGreaterThan(0.34);
    });

    test('returns the original image without re-encoding when dimensions already match', async () => {
        const input = Buffer.from('already-exact');
        const sharpFactory = jest.fn();

        const result = await normalizeImageBuffer(input, {
            requestedSize: '1024x1024',
            sourceMetadata: { width: 1024, height: 1024, format: 'png' },
            sharpFactory
        });

        expect(result.buffer).toBe(input);
        expect(result.metadata.size_adjusted).toBe(false);
        expect(result.metadata.scale_operation).toBe('none');
        expect(sharpFactory).not.toHaveBeenCalled();
    });

    test('stretches a small mismatch to the exact requested dimensions', async () => {
        const output = Buffer.from('normalized');
        const toBuffer = jest.fn(async () => output);
        const png = jest.fn(() => ({ toBuffer }));
        const resize = jest.fn(() => ({ png }));
        const sharpFactory = jest.fn(() => ({ resize }));

        const result = await normalizeImageBuffer(Buffer.from('source'), {
            requestedSize: '1024x1024',
            sourceMetadata: { width: 1277, height: 1232, format: 'png' },
            sharpFactory,
            aspectMismatchThreshold: 0.10,
            outputFormat: 'png'
        });

        expect(resize).toHaveBeenCalledWith(1024, 1024, expect.objectContaining({ fit: 'fill' }));
        expect(result.buffer).toBe(output);
        expect(result.metadata).toEqual(expect.objectContaining({
            source_size: '1277x1232',
            final_size: '1024x1024',
            size_adjusted: true,
            aspect_adjusted: true,
            upscaled: false,
            scale_operation: 'downscale',
            native_resolution: false
        }));
    });

    test('accepts an exact 10 percent aspect deviation boundary', async () => {
        const toBuffer = jest.fn(async () => Buffer.from('normalized'));
        const png = jest.fn(() => ({ toBuffer }));
        const resize = jest.fn(() => ({ png }));
        const sharpFactory = jest.fn(() => ({ resize }));

        await expect(normalizeImageBuffer(Buffer.from('source'), {
            requestedSize: '100x100',
            sourceMetadata: { width: 100, height: 90, format: 'png' },
            sharpFactory,
            aspectMismatchThreshold: 0.10
        })).resolves.toMatchObject({
            metadata: expect.objectContaining({
                aspect_deviation: 0.1,
                final_size: '100x100'
            })
        });
    });

    test('marks an enlargement as upscaled', async () => {
        const toBuffer = jest.fn(async () => Buffer.from('larger'));
        const png = jest.fn(() => ({ toBuffer }));
        const resize = jest.fn(() => ({ png }));
        const sharpFactory = jest.fn(() => ({ resize }));

        const result = await normalizeImageBuffer(Buffer.from('small'), {
            requestedSize: '1024x1024',
            sourceMetadata: { width: 768, height: 768, format: 'png' },
            sharpFactory
        });

        expect(result.metadata.upscaled).toBe(true);
        expect(result.metadata.scale_operation).toBe('upscale');
    });

    test('rejects an extreme mismatch with structured Chinese details', async () => {
        await expect(normalizeImageBuffer(Buffer.from('wide'), {
            requestedSize: '1536x1024',
            sourceMetadata: { width: 1903, height: 826, format: 'png' },
            sharpFactory: jest.fn(),
            aspectMismatchThreshold: 0.10,
            imageIndex: 2
        })).rejects.toMatchObject({
            name: 'ImageAspectRatioMismatchError',
            statusCode: 422,
            type: 'image_aspect_ratio_mismatch',
            message: '生成图片的长宽比与请求尺寸差异过大，已停止缩放以避免图片明显变形。',
            details: expect.objectContaining({
                requested_size: '1536x1024',
                source_size: '1903x826',
                allowed_deviation: 0.10,
                image_index: 2
            })
        });
        expect(ImageAspectRatioMismatchError).toBeDefined();
    });

    test('uses real sharp processing to produce an exact WebP result', async () => {
        const source = await sharp({
            create: { width: 125, height: 125, channels: 4, background: '#2457a6' }
        }).png().toBuffer();

        const result = await normalizeImageBuffer(source, {
            requestedSize: '100x100',
            outputFormat: 'webp'
        });
        const metadata = await sharp(result.buffer).metadata();

        expect(metadata.format).toBe('webp');
        expect([metadata.width, metadata.height]).toEqual([100, 100]);
    });

    test('marks opposite width and height scaling directions as mixed_scale', async () => {
        const source = await sharp({
            create: { width: 105, height: 100, channels: 4, background: '#2457a6' }
        }).png().toBuffer();

        const result = await normalizeImageBuffer(source, {
            requestedSize: '100x105',
            aspectMismatchThreshold: 0.10
        });

        expect(result.metadata.scale_operation).toBe('mixed_scale');
        expect(result.metadata.upscaled).toBe(true);
    });

    test('returns a Chinese 502 error for corrupt image data', async () => {
        await expect(normalizeImageBuffer(Buffer.from('not-an-image'), {
            requestedSize: '100x100'
        })).rejects.toMatchObject({
            statusCode: 502,
            type: 'image_postprocess_failed',
            message: '生成图片解析失败，无法读取图片尺寸。'
        });
    });
});
