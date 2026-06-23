import { countTextTokens, processContent } from '../../utils/token-utils.js';

const SECTION_LABELS = {
    instructions: 'System / Instructions',
    tools: 'Tool definitions',
    conversation: 'Conversation',
    attachments: 'Attachments / Images',
    metadata: 'Request metadata',
    cached_input: 'Cached input',
    output: 'Output',
    reasoning: 'Reasoning'
};

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function textTokens(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'string') return countTextTokens(value);
    return countTextTokens(processContent(value));
}

function jsonTokens(value) {
    if (value === undefined || value === null) return 0;
    try {
        return countTextTokens(JSON.stringify(value));
    } catch (_error) {
        return 0;
    }
}

function addSection(sections, id, estimatedTokens) {
    const tokens = Math.max(0, Math.ceil(toNumber(estimatedTokens)));
    if (tokens <= 0) return;
    const existing = sections.find(section => section.id === id);
    if (existing) {
        existing.estimatedTokens += tokens;
        return;
    }
    sections.push({
        id,
        label: SECTION_LABELS[id] || id,
        estimatedTokens: tokens
    });
}

function splitContentTokens(content) {
    let text = 0;
    let attachments = 0;

    if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'string') {
                text += textTokens(part);
                continue;
            }
            if (!part || typeof part !== 'object') continue;
            const type = String(part.type || '').toLowerCase();
            if (type.includes('image') || part.image_url || part.inlineData || part.source?.type === 'base64') {
                attachments += estimateAttachmentTokens(part);
            } else if (type.includes('document') || type.includes('file')) {
                attachments += estimateAttachmentTokens(part);
            } else {
                text += textTokens(part.text ?? part.content ?? part.input ?? part);
            }
        }
        return { text, attachments };
    }

    return { text: textTokens(content), attachments };
}

function estimateAttachmentTokens(part) {
    const data =
        part?.image_url?.url ||
        part?.inlineData?.data ||
        part?.source?.data ||
        part?.data ||
        '';
    if (typeof data === 'string' && data.length > 0) {
        return Math.max(1600, Math.ceil(data.length * 0.75 / 4));
    }
    return 1600;
}

function classifyMessages(messages, sections) {
    for (const message of Array.isArray(messages) ? messages : []) {
        const role = String(message?.role || '').toLowerCase();
        const { text, attachments } = splitContentTokens(message?.content);
        if (role === 'system' || role === 'developer') {
            addSection(sections, 'instructions', text);
        } else {
            addSection(sections, 'conversation', text);
        }
        addSection(sections, 'attachments', attachments);
    }
}

function classifyResponsesInput(input, sections) {
    if (typeof input === 'string') {
        addSection(sections, 'conversation', textTokens(input));
        return;
    }

    for (const item of Array.isArray(input) ? input : []) {
        if (typeof item === 'string') {
            addSection(sections, 'conversation', textTokens(item));
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        if (item.role || item.content) {
            classifyMessages([item], sections);
            continue;
        }
        const type = String(item.type || '').toLowerCase();
        if (type.includes('image') || type.includes('file')) {
            addSection(sections, 'attachments', estimateAttachmentTokens(item));
        } else {
            addSection(sections, 'conversation', textTokens(item.text ?? item.input ?? item));
        }
    }
}

function classifyGeminiContents(contents, sections) {
    for (const content of Array.isArray(contents) ? contents : []) {
        const parts = content?.parts || [];
        for (const part of parts) {
            if (part?.text) {
                addSection(sections, 'conversation', textTokens(part.text));
            } else {
                addSection(sections, 'attachments', estimateAttachmentTokens(part));
            }
        }
    }
}

function addMetadata(body, sections) {
    const metadata = {};
    for (const key of ['reasoning', 'thinking', 'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'tool_choice']) {
        if (body?.[key] !== undefined) metadata[key] = body[key];
    }
    addSection(sections, 'metadata', jsonTokens(metadata));
}

function classifyBody(body, sections) {
    if (!body || typeof body !== 'object') return;

    if (body.instructions) addSection(sections, 'instructions', textTokens(body.instructions));
    if (body.system) addSection(sections, 'instructions', textTokens(body.system));
    if (body.systemInstruction) addSection(sections, 'instructions', jsonTokens(body.systemInstruction));

    if (body.tools) addSection(sections, 'tools', jsonTokens(body.tools));
    if (body.tool_choice) addSection(sections, 'metadata', jsonTokens(body.tool_choice));

    if (body.messages) classifyMessages(body.messages, sections);
    if (body.input) classifyResponsesInput(body.input, sections);
    if (body.contents) classifyGeminiContents(body.contents, sections);

    addMetadata(body, sections);
}

function calibrateSections(sections, promptTokens) {
    const promptTotal = toNumber(promptTokens);
    const estimatedTotal = sections.reduce((sum, section) => sum + toNumber(section.estimatedTokens), 0);
    const scale = promptTotal > 0 && estimatedTotal > 0 ? promptTotal / estimatedTotal : 1;

    return sections.map(section => {
        const calibratedTokens = Math.round(toNumber(section.estimatedTokens) * scale);
        return {
            ...section,
            calibratedTokens,
            percentOfPrompt: promptTotal > 0 ? calibratedTokens / promptTotal : 0
        };
    });
}

export function buildContextBreakdown({ originalRequestBody, processedRequestBody, usage = {} } = {}) {
    const sections = [];
    classifyBody(originalRequestBody, sections);
    if (sections.length === 0) {
        classifyBody(processedRequestBody, sections);
    }

    const promptTokens = toNumber(usage.promptTokens);
    const calibrated = calibrateSections(sections, promptTokens);
    const cachedTokens = toNumber(usage.cachedTokens);
    if (cachedTokens > 0) {
        calibrated.push({
            id: 'cached_input',
            label: SECTION_LABELS.cached_input,
            tokens: cachedTokens,
            percentOfPrompt: promptTokens > 0 ? cachedTokens / promptTokens : 0
        });
    }

    return {
        estimationMethod: 'anthropic-tokenizer-ratio-calibrated',
        sections: calibrated
    };
}
