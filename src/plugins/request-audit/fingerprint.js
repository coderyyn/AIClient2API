import crypto from 'crypto';

const MAX_STRING_CHARS = 200_000;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;
const PREFIX_WINDOWS = [4096, 8192, 16384, 32768];

function hashValue(value, length = 16) {
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableNormalize(value, depth = 0) {
    if (value === undefined) return null;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) : value;
    }
    if (depth >= MAX_DEPTH) return '[depth-limit]';

    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map(item => stableNormalize(item, depth + 1));
    }

    if (isPlainObject(value)) {
        const result = {};
        for (const key of Object.keys(value).sort().slice(0, MAX_OBJECT_KEYS)) {
            result[key] = stableNormalize(value[key], depth + 1);
        }
        return result;
    }

    return String(value);
}

function stableStringify(value) {
    return JSON.stringify(stableNormalize(value));
}

function summarizeShape(value, depth = 0) {
    if (value === undefined || value === null) return value === null ? 'null' : 'undefined';
    if (typeof value === 'string') return `string:${value.length}`;
    if (typeof value === 'number' || typeof value === 'boolean') return typeof value;
    if (depth >= MAX_DEPTH) return '[depth-limit]';
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(item => summarizeShape(item, depth + 1));
    if (isPlainObject(value)) {
        const result = {};
        for (const key of Object.keys(value).sort().slice(0, MAX_OBJECT_KEYS)) {
            result[key] = summarizeShape(value[key], depth + 1);
        }
        return result;
    }
    return typeof value;
}

function getBody(context = {}) {
    return context.processedRequestBody || context.originalRequestBody || {};
}

function pickMetadata(body = {}) {
    const metadata = {};
    for (const key of ['model', 'reasoning', 'thinking', 'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'tool_choice', 'store', 'stream']) {
        if (body?.[key] !== undefined) metadata[key] = body[key];
    }
    return metadata;
}

function extractInstructions(body = {}) {
    const values = [];
    if (body.instructions) values.push(body.instructions);
    if (body.system) values.push(body.system);
    if (body.systemInstruction) values.push(body.systemInstruction);
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
        const role = String(message?.role || '').toLowerCase();
        if (role === 'system' || role === 'developer') values.push(message.content);
    }
    for (const item of Array.isArray(body.input) ? body.input : []) {
        const role = String(item?.role || '').toLowerCase();
        if (role === 'system' || role === 'developer') values.push(item.content || item.text || item);
    }
    return values;
}

function extractConversationText(body = {}) {
    const chunks = [];
    const pushContent = content => {
        if (typeof content === 'string') {
            chunks.push(content);
            return;
        }
        if (Array.isArray(content)) {
            for (const part of content) {
                if (typeof part === 'string') chunks.push(part);
                else if (part?.text) chunks.push(part.text);
                else if (part?.content && typeof part.content === 'string') chunks.push(part.content);
            }
        }
    };

    if (typeof body.input === 'string') chunks.push(body.input);
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
        const role = String(message?.role || '').toLowerCase();
        if (role !== 'system' && role !== 'developer') pushContent(message.content);
    }
    for (const item of Array.isArray(body.input) ? body.input : []) {
        const role = String(item?.role || '').toLowerCase();
        if (role !== 'system' && role !== 'developer') pushContent(item.content ?? item.text ?? item.input);
    }
    for (const content of Array.isArray(body.contents) ? body.contents : []) {
        for (const part of Array.isArray(content?.parts) ? content.parts : []) {
            if (part?.text) chunks.push(part.text);
        }
    }
    return chunks.join('\n');
}

function estimateAttachmentCount(value) {
    let count = 0;
    const visit = (item, depth = 0) => {
        if (!item || depth > MAX_DEPTH) return;
        if (Array.isArray(item)) {
            for (const child of item.slice(0, MAX_ARRAY_ITEMS)) visit(child, depth + 1);
            return;
        }
        if (!isPlainObject(item)) return;
        const type = String(item.type || '').toLowerCase();
        if (type.includes('image') || type.includes('file') || item.image_url || item.inlineData || item.source?.type === 'base64') {
            count += 1;
        }
        for (const key of Object.keys(item).slice(0, MAX_OBJECT_KEYS)) visit(item[key], depth + 1);
    };
    visit(value);
    return count;
}

function buildPrefixHashes(text) {
    const value = String(text || '');
    return PREFIX_WINDOWS
        .filter(size => value.length >= Math.min(size, value.length) && value.length > 0)
        .map(size => {
            const slice = value.slice(0, Math.min(size, value.length));
            return {
                chars: slice.length,
                hash: hashValue(slice)
            };
        });
}

function sectionSummary(value) {
    const text = stableStringify(value);
    return {
        hash: hashValue(text),
        charLength: text.length
    };
}

export function buildRequestFingerprint(context = {}) {
    const body = getBody(context);
    const payloadText = stableStringify(body);
    const shapeText = stableStringify(summarizeShape(body));
    const instructions = extractInstructions(body);
    const tools = body.tools || [];
    const metadata = pickMetadata(body);
    const conversationText = extractConversationText(body);

    return {
        version: 1,
        payloadHash: hashValue(payloadText),
        shapeHash: hashValue(shapeText),
        instructionsHash: hashValue(stableStringify(instructions)),
        toolsHash: hashValue(stableStringify(tools)),
        metadataHash: hashValue(stableStringify(metadata)),
        prefixHashes: buildPrefixHashes(conversationText),
        sections: {
            instructions: sectionSummary(instructions),
            tools: sectionSummary(tools),
            metadata: sectionSummary(metadata),
            conversation: {
                hash: hashValue(conversationText.slice(0, MAX_STRING_CHARS)),
                charLength: conversationText.length
            },
            attachments: {
                count: estimateAttachmentCount(body)
            }
        },
        warnings: payloadText.length >= MAX_STRING_CHARS ? ['payload_truncated_for_fingerprint'] : []
    };
}
