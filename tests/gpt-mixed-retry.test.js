import requestContext from '../src/utils/context.js';
import { mixedRetryBody } from '../src/utils/common.js';
import { convertData } from '../src/convert/convert.js';
import { MIXED_CODEX, MIXED_KEY } from '../src/services/gpt-mixed-routing.js';
import '../src/converters/register-converters.js';

const model = 'gpt-6-sol';
const body = {
    model,
    input: [
        { type: 'function_call', name: 'lookup', call_id: 'call-1', arguments: '{"id":1}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'fixture result' }
    ],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { id: { type: 'number' } } } }],
    previous_response_id: 'fixture-response'
};

test('Codex to Key retry rebuilds the native request and retains tools and continuation parameters', async () => {
    const context = { CONFIG: {}, mixedRequestSource: { provider: 'openaiResponses', body } };
    await requestContext.run({ gptMixedState: { selection: { model } } }, async () => {
        const codex = convertData(body, 'request', 'openaiResponses', MIXED_CODEX);
        const retry = await mixedRetryBody(codex, MIXED_CODEX, MIXED_KEY, context);
        expect(retry).toEqual(body);
        expect(retry).not.toBe(body);
    });
});

test('Chat Completions retries convert from the original client protocol in either direction', async () => {
    const chat = { model, messages: [{ role: 'user', content: 'fixture' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] };
    const context = { CONFIG: {}, mixedRequestSource: { provider: 'openai', body: chat } };
    await requestContext.run({ gptMixedState: { selection: { model } } }, async () => {
        const key = await mixedRetryBody({}, MIXED_CODEX, MIXED_KEY, context);
        const codex = await mixedRetryBody(key, MIXED_KEY, MIXED_CODEX, context);
        expect(key.input).toBeDefined();
        expect(codex.input).toBeDefined();
        expect(key.tools[0].name).toBe('lookup');
        expect(codex.tools[0].name).toBe('lookup');
        expect(chat.messages[0].content).toBe('fixture');
    });
});

test('same-provider retry preserves its processed body', async () => {
    await requestContext.run({ gptMixedState: { selection: { model } } }, async () => {
        expect(await mixedRetryBody(body, MIXED_CODEX, MIXED_CODEX, {})).toBe(body);
        await expect(mixedRetryBody(body, MIXED_CODEX, MIXED_KEY, {}))
            .rejects.toMatchObject({ status: 503, code: 'MIXED_REQUEST_SOURCE_UNAVAILABLE' });
    });
});
