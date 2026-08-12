import { writeWithBackpressure } from './runtime-backpressure.js';

async function writeQuotedString(response, value, chunkChars) {
    await writeWithBackpressure(response, '"');
    for (let offset = 0; offset < value.length; offset += chunkChars) {
        await writeWithBackpressure(response, value.slice(offset, offset + chunkChars));
    }
    await writeWithBackpressure(response, '"');
}

async function writeJsonValue(response, value, chunkChars) {
    if (typeof value === 'string' && !/["\\\u0000-\u001f]/.test(value)) {
        return writeQuotedString(response, value, chunkChars);
    }
    if (Array.isArray(value)) {
        await writeWithBackpressure(response, '[');
        for (let index = 0; index < value.length; index++) {
            if (index) await writeWithBackpressure(response, ',');
            await writeJsonValue(response, value[index], chunkChars);
        }
        await writeWithBackpressure(response, ']');
        return;
    }
    if (value && typeof value === 'object') {
        await writeWithBackpressure(response, '{');
        const entries = Object.entries(value);
        for (let index = 0; index < entries.length; index++) {
            if (index) await writeWithBackpressure(response, ',');
            const [key, child] = entries[index];
            await writeWithBackpressure(response, `${JSON.stringify(key)}:`);
            await writeJsonValue(response, child, chunkChars);
        }
        await writeWithBackpressure(response, '}');
        return;
    }
    await writeWithBackpressure(response, JSON.stringify(value));
}

export async function writeImageJsonResponse(response, payload, { statusCode = 200, headers = {}, chunkChars = 64 * 1024 } = {}) {
    response.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    // Lightweight in-process test adapters often only implement end(body).
    // Keep that contract while real Node responses use chunked writes.
    if (typeof response.write !== 'function') {
        response.end(JSON.stringify(payload));
        return;
    }
    await writeJsonValue(response, payload, Math.max(1024, Number(chunkChars) || 64 * 1024));
    response.end();
}
