import crypto from 'crypto';

const MAX_LOG_STRING_CHARS = 1000;
const BASE64_LIKE_MIN_CHARS = 200;
const EXPLICIT_BASE64_KEYS = new Set(['b64_json', 'base64']);

function hashPreview(bufferOrString) {
    return crypto.createHash('sha256').update(bufferOrString).digest('hex').slice(0, 16);
}

function summarizeDataUri(value) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(value);
    if (!match) return null;

    const mediaType = match[1] || 'application/octet-stream';
    const isBase64 = !!match[2];
    const data = match[3] || '';

    if (!isBase64) {
        return {
            kind: 'data-uri',
            media_type: mediaType,
            chars: data.length,
            sha256: hashPreview(data)
        };
    }

    const compactBase64 = data.replace(/\s+/g, '');
    const base64Summary = summarizeBase64(compactBase64);
    return {
        kind: 'data-uri',
        media_type: mediaType,
        base64_chars: compactBase64.length,
        bytes: base64Summary.bytes,
        sha256: base64Summary.sha256
    };
}

function summarizeBase64(value) {
    const compactBase64 = String(value || '').replace(/\s+/g, '');
    let bytes = null;
    let sha256 = hashPreview(compactBase64);

    try {
        if (/^[A-Za-z0-9+/]*={0,2}$/.test(compactBase64)) {
            const decoded = Buffer.from(compactBase64, 'base64');
            bytes = decoded.length;
            sha256 = hashPreview(decoded);
        }
    } catch (error) {
        bytes = null;
        sha256 = hashPreview(compactBase64);
    }

    return {
        kind: 'base64',
        chars: compactBase64.length,
        bytes,
        sha256
    };
}

function looksLikeLargeBase64(value) {
    const compact = value.replace(/\s+/g, '');
    return compact.length >= BASE64_LIKE_MIN_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function summarizeString(value, key) {
    const dataUriSummary = summarizeDataUri(value);
    if (dataUriSummary) return dataUriSummary;

    if (EXPLICIT_BASE64_KEYS.has(key)) {
        return summarizeBase64(value);
    }

    if (looksLikeLargeBase64(value)) {
        return summarizeBase64(value);
    }

    if (value.length > MAX_LOG_STRING_CHARS) {
        return {
            kind: 'long-string',
            chars: value.length,
            preview: value.slice(0, 160),
            sha256: hashPreview(value)
        };
    }

    return value;
}

export function summarizePayloadForLog(value, seen = new WeakSet(), key = '') {
    if (typeof value === 'string') {
        return summarizeString(value, key);
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    if (Buffer.isBuffer(value)) {
        return {
            kind: 'buffer',
            bytes: value.length,
            sha256: hashPreview(value)
        };
    }

    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => summarizePayloadForLog(item, seen, key));
    }

    return Object.fromEntries(
        Object.entries(value).map(([childKey, item]) => [
            childKey,
            summarizePayloadForLog(item, seen, childKey)
        ])
    );
}

export function stringifyPayloadForLog(value) {
    return JSON.stringify(summarizePayloadForLog(value));
}
