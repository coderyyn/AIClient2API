import sharp from 'sharp';

const DEFAULT_MAX_DIMENSION = 4096;
const DEFAULT_MAX_PIXELS = 8_388_608;
const DEFAULT_ASPECT_MISMATCH_THRESHOLD = 0.10;

function greatestCommonDivisor(a, b) {
    let left = Math.abs(a);
    let right = Math.abs(b);
    while (right !== 0) {
        [left, right] = [right, left % right];
    }
    return left || 1;
}

function boundedNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function normalizeAspectMismatchThreshold(value, fallback = DEFAULT_ASPECT_MISMATCH_THRESHOLD) {
    const fallbackNumber = Number(fallback);
    const safeFallback = Number.isFinite(fallbackNumber) && fallbackNumber > 0 && fallbackNumber <= 1
        ? fallbackNumber
        : DEFAULT_ASPECT_MISMATCH_THRESHOLD;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1 ? number : safeFallback;
}

export class ImageSizeValidationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ImageSizeValidationError';
        this.statusCode = 400;
        this.type = 'invalid_image_size';
        this.details = details;
    }
}

export class ImageAspectRatioMismatchError extends Error {
    constructor(details) {
        super('生成图片的长宽比与请求尺寸差异过大，已停止缩放以避免图片明显变形。');
        this.name = 'ImageAspectRatioMismatchError';
        this.statusCode = 422;
        this.type = 'image_aspect_ratio_mismatch';
        this.details = {
            ...details,
            suggestion: '请重试生成，或调整提示词中的画幅描述。'
        };
    }
}

export class ImagePostprocessError extends Error {
    constructor(message, details = {}, cause = null) {
        super(message);
        this.name = 'ImagePostprocessError';
        this.statusCode = 502;
        this.type = 'image_postprocess_failed';
        this.details = details;
        if (cause) this.cause = cause;
    }
}

export function parseRequestedImageSize(size, {
    maxDimension = DEFAULT_MAX_DIMENSION,
    maxPixels = DEFAULT_MAX_PIXELS
} = {}) {
    if (size === undefined || size === null) return null;
    const text = String(size).trim().toLowerCase();
    if (!text || text === 'auto') return null;

    const match = /^(\d+)x(\d+)$/.exec(text);
    if (!match) {
        throw new ImageSizeValidationError('图片尺寸格式无效，请使用 WIDTHxHEIGHT，例如 1024x1024。', {
            requested_size: text
        });
    }

    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    const dimensionLimit = boundedNumber(maxDimension, DEFAULT_MAX_DIMENSION);
    const pixelLimit = boundedNumber(maxPixels, DEFAULT_MAX_PIXELS);
    if (width <= 0 || height <= 0 || width > dimensionLimit || height > dimensionLimit || width * height > pixelLimit) {
        throw new ImageSizeValidationError(
            `请求的图片尺寸过大，单边不能超过 ${dimensionLimit} 像素且总像素不能超过 ${pixelLimit}。`,
            {
                requested_size: `${width}x${height}`,
                max_dimension: dimensionLimit,
                max_pixels: pixelLimit
            }
        );
    }

    const divisor = greatestCommonDivisor(width, height);
    return {
        width,
        height,
        text: `${width}x${height}`,
        aspectWidth: width / divisor,
        aspectHeight: height / divisor
    };
}

export function appendAspectRatioConstraint(prompt, size, options = {}) {
    const requested = parseRequestedImageSize(size, options);
    const originalPrompt = String(prompt || '');
    if (!requested) {
        return { originalPrompt, prompt: originalPrompt, promptConstraintApplied: false, requestedSize: null };
    }

    const ratio = `${requested.aspectWidth}:${requested.aspectHeight}`;
    const suffix = `[ASPECT RATIO] Strict ${ratio}`;

    return {
        originalPrompt,
        prompt: originalPrompt ? `${originalPrompt}\n\n${suffix}` : suffix,
        promptConstraintApplied: true,
        requestedSize: requested
    };
}

export function calculateAspectDeviation(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const sourceRatio = Number(sourceWidth) / Number(sourceHeight);
    const targetRatio = Number(targetWidth) / Number(targetHeight);
    if (![sourceRatio, targetRatio].every(value => Number.isFinite(value) && value > 0)) return 1;
    return 1 - Math.min(sourceRatio / targetRatio, targetRatio / sourceRatio);
}

function normalizeOutputFormat(value, fallback = 'png') {
    const normalized = String(value || fallback).trim().toLowerCase();
    if (normalized === 'jpg') return 'jpeg';
    return ['png', 'jpeg', 'webp'].includes(normalized) ? normalized : fallback;
}

function getScaleOperation(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    if (sourceWidth === targetWidth && sourceHeight === targetHeight) return 'none';
    const widthGrows = targetWidth > sourceWidth;
    const heightGrows = targetHeight > sourceHeight;
    const widthShrinks = targetWidth < sourceWidth;
    const heightShrinks = targetHeight < sourceHeight;
    if ((widthGrows || targetWidth === sourceWidth) && (heightGrows || targetHeight === sourceHeight)) return 'upscale';
    if ((widthShrinks || targetWidth === sourceWidth) && (heightShrinks || targetHeight === sourceHeight)) return 'downscale';
    return 'mixed_scale';
}

function encodePipeline(pipeline, outputFormat) {
    if (outputFormat === 'jpeg') return pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
    if (outputFormat === 'webp') return pipeline.webp({ quality: 95 });
    return pipeline.png({ compressionLevel: 9 });
}

export async function normalizeImageBuffer(inputBuffer, {
    requestedSize,
    aspectMismatchThreshold = DEFAULT_ASPECT_MISMATCH_THRESHOLD,
    maxDimension = DEFAULT_MAX_DIMENSION,
    maxPixels = DEFAULT_MAX_PIXELS,
    outputFormat = null,
    sourceMetadata = null,
    imageIndex = 0,
    sharpFactory = sharp
} = {}) {
    const requested = parseRequestedImageSize(requestedSize, { maxDimension, maxPixels });
    if (!requested) {
        return {
            buffer: inputBuffer,
            metadata: {
                source_size: null,
                final_size: null,
                size_adjusted: false,
                aspect_adjusted: false,
                upscaled: false,
                scale_operation: 'none',
                native_resolution: true
            }
        };
    }

    let source = sourceMetadata;
    try {
        source = source || await sharpFactory(inputBuffer).metadata();
    } catch (error) {
        throw new ImagePostprocessError('生成图片解析失败，无法读取图片尺寸。', {
            requested_size: requested.text,
            image_index: imageIndex
        }, error);
    }

    const sourceWidth = Number(source?.width);
    const sourceHeight = Number(source?.height);
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
        throw new ImagePostprocessError('生成图片缺少有效的宽高信息，无法执行尺寸归一化。', {
            requested_size: requested.text,
            image_index: imageIndex
        });
    }

    const sourceSize = `${sourceWidth}x${sourceHeight}`;
    const aspectDeviation = calculateAspectDeviation(
        sourceWidth,
        sourceHeight,
        requested.width,
        requested.height
    );
    const roundedDeviation = Number(aspectDeviation.toFixed(6));
    const threshold = normalizeAspectMismatchThreshold(aspectMismatchThreshold);

    if (aspectDeviation > threshold + 1e-12) {
        throw new ImageAspectRatioMismatchError({
            requested_size: requested.text,
            source_size: sourceSize,
            aspect_deviation: roundedDeviation,
            allowed_deviation: threshold,
            image_index: imageIndex
        });
    }

    if (sourceWidth === requested.width && sourceHeight === requested.height) {
        return {
            buffer: inputBuffer,
            metadata: {
                source_size: sourceSize,
                final_size: requested.text,
                size_adjusted: false,
                aspect_adjusted: false,
                aspect_deviation: roundedDeviation,
                upscaled: false,
                scale_operation: 'none',
                native_resolution: true
            }
        };
    }

    const scaleOperation = getScaleOperation(sourceWidth, sourceHeight, requested.width, requested.height);
    const finalFormat = normalizeOutputFormat(outputFormat, normalizeOutputFormat(source?.format, 'png'));
    try {
        const pipeline = sharpFactory(inputBuffer).resize(requested.width, requested.height, {
            fit: 'fill',
            kernel: 'lanczos3'
        });
        const buffer = await encodePipeline(pipeline, finalFormat).toBuffer();
        return {
            buffer,
            outputFormat: finalFormat,
            metadata: {
                source_size: sourceSize,
                final_size: requested.text,
                size_adjusted: true,
                aspect_adjusted: aspectDeviation > 0,
                aspect_deviation: roundedDeviation,
                upscaled: requested.width > sourceWidth || requested.height > sourceHeight,
                scale_operation: scaleOperation,
                native_resolution: false
            }
        };
    } catch (error) {
        throw new ImagePostprocessError('生成图片尺寸处理失败，请稍后重试。', {
            requested_size: requested.text,
            source_size: sourceSize,
            image_index: imageIndex
        }, error);
    }
}

export const IMAGE_SIZE_NORMALIZER_DEFAULTS = {
    maxDimension: DEFAULT_MAX_DIMENSION,
    maxPixels: DEFAULT_MAX_PIXELS,
    aspectMismatchThreshold: DEFAULT_ASPECT_MISMATCH_THRESHOLD
};
