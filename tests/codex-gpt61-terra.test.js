import fs from 'node:fs';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { getProviderModels } from '../src/providers/provider-models.js';
import { getCodexModelIds, normalizeCodexReasoningEffort } from '../src/providers/openai/codex-model-capabilities.js';
import { estimateUsageCost, getModelPricing } from '../src/plugins/api-potluck/cost-estimator.js';

jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

const variants = ['gpt-6.1-terra', 'gpt-6.1-terra-fast'];
// 出站请求不发送 default 档位（对齐原生 Codex）。
const outboundTiers = [undefined, 'priority'];
const services = [];
function createService(config = {}) {
    const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', ...config });
    services.push(service);
    return service;
}
afterEach(() => {
    services.splice(0).forEach(service => service.stopCacheCleanup());
    axios.request.mockReset();
});

describe('GPT-6.1 Terra Codex support', () => {
    test('lists standard and Fast variants only, and offers the credential override', async () => {
        const ids = getCodexModelIds(getProviderModels('openai-codex-oauth'));
        expect(ids).toEqual(expect.arrayContaining([...variants, 'gpt-6.1-sol-ultrafast']));
        expect(ids).not.toContain('gpt-6.1-terra-ultrafast');
        const ui = fs.readFileSync(new URL('../static/app/utils.js', import.meta.url), 'utf8');
        expect(ui).toContain("{ value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }");
        const listed = await createService().listModels();
        expect(listed.data.map(model => model.id)).toEqual(expect.arrayContaining(variants));
    });

    test.each(variants)('%s keeps reasoning independent of speed', async model => {
        const service = createService();
        for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none', 'invalid', undefined]) {
            const expected = effort === 'minimal' ? 'low'
                : ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'medium';
            const body = await service.prepareRequestBody(model, {
                input: 'test', reasoning: { effort }, temperature: 0.2, top_p: 0.8,
                top_logprobs: 1, include: ['reasoning.encrypted_content', 'message.output_text.logprobs']
            }, true);
            expect(body.model).toBe('gpt-6.1-terra');
            expect(body.service_tier).toBe(outboundTiers[variants.indexOf(model)]);
            expect(body.reasoning.effort).toBe(expected);
            expect(body).not.toHaveProperty('temperature');
            expect(body).not.toHaveProperty('top_p');
            expect(body).not.toHaveProperty('top_logprobs');
            expect(body.include).toEqual(['reasoning.encrypted_content']);
            expect(normalizeCodexReasoningEffort(model, effort)).toBe(expected);
        }
        const topLevel = await service.prepareRequestBody(model, { input: 'test', reasoning_effort: 'high' }, false);
        expect(topLevel.reasoning.effort).toBe('high');
        expect(topLevel).not.toHaveProperty('reasoning_effort');
    });

    test('can be the credential override target', async () => {
        const service = createService({ codexGpt6OverrideEnabled: true, codexGpt6OverrideModel: 'gpt-6.1-terra' });
        const body = await service.prepareRequestBody('gpt-6-sol', { input: 'test', reasoning: { effort: 'low' } }, true);
        expect(body.model).toBe('gpt-6.1-terra');
        expect(body.reasoning.effort).toBe('low');
    });

    test('falls back to the default client identity for inbound Codex clients older than 0.159.0', () => {
        const service = createService({ CODEX_CLOAKING_ENABLED: false });
        const inbound = version => name => ({
            'user-agent': `codex-tui/${version} (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; ${version})`,
            originator: 'codex-tui'
        })[name];
        expect(service.resolveClientIdentity('gpt-6.1-terra', inbound('0.158.2')).userAgent).not.toContain('0.158.2');
        expect(service.resolveClientIdentity('gpt-6.1-terra', inbound('0.159.0')).userAgent).toContain('codex-tui/0.159.0');
        expect(service.resolveClientIdentity('gpt-6.1-sol', inbound('0.158.2')).userAgent).toContain('codex-tui/0.158.2');
    });

    test.each(variants)('%s passes a Chat request through a mocked upstream', async model => {
        const converter = new CodexConverter();
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'mock-token';
        const completed = {
            type: 'response.completed',
            response: { id: 'resp_mock', model: 'gpt-6.1-terra', status: 'completed',
                service_tier: ['default', 'priority'][variants.indexOf(model)],
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '2' }] }],
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }
        };
        const chat = converter.toOpenAIRequestToCodexRequest({ model, reasoning_effort: 'low',
            messages: [{ role: 'user', content: 'test' }] }, `chat-${model}`);
        axios.request.mockResolvedValueOnce({ data: JSON.stringify(completed) });
        const response = await service.generateContent(model, chat);
        expect(converter.toOpenAIResponse(response, model, `chat-${model}`).choices[0].message.content).toBe('2');
        const sent = axios.request.mock.calls[0][0];
        expect(sent.data.model).toBe('gpt-6.1-terra');
        expect(sent.data.service_tier).toBe(outboundTiers[variants.indexOf(model)]);
        expect(sent.data.reasoning.effort).toBe('low');
    });

    test.each(variants)('%s uses official pricing with a 2x Fast multiplier', model => {
        expect(getModelPricing(model)).toMatchObject({ input: 1, cachedInput: 0.05, output: 5 });
        const usage = { promptTokens: 1_000_000, cachedTokens: 250_000, completionTokens: 100_000,
            totalTokens: 1_100_000, cacheWriteTokens: 50_000 };
        const cost = estimateUsageCost(usage, model);
        expect(cost.usd).toBeCloseTo(1.2625 * [1, 2][variants.indexOf(model)], 10);
        expect(cost.missingPriceTokens).toBe(0);
        expect(cost.estimatedPriceTokens).toBe(0);
    });
});
