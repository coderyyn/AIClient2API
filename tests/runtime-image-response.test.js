import { EventEmitter } from 'events';
import { writeImageJsonResponse } from '../src/runtime/image-json-response.js';

test('streams large Base64 JSON in bounded chunks and preserves the response schema', async () => {
    const output = [];
    const response = new EventEmitter();
    response.writeHead = jest.fn();
    response.write = chunk => { output.push(String(chunk)); return true; };
    response.end = jest.fn();
    const payload = { created: 1, data: [{ b64_json: 'A'.repeat(2 * 1024 * 1024) }, { url: 'https://example.invalid/image.png' }] };

    await writeImageJsonResponse(response, payload, { chunkChars: 64 * 1024 });

    expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'application/json' }));
    expect(Math.max(...output.map(chunk => chunk.length))).toBeLessThanOrEqual(64 * 1024 + 128);
    expect(JSON.parse(output.join(''))).toEqual(payload);
    expect(response.end).toHaveBeenCalled();
});
