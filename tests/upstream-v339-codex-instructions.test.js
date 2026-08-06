import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let consoleSpies = [];

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('Codex custom request compatibility', () => {
    test('keeps Codex client input items unchanged', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });
        const input = [
            {
                type: 'additional_tools',
                role: 'developer',
                tools: [{
                    type: 'function',
                    name: 'shell',
                    parameters: { type: 'object', properties: {} }
                }]
            },
            { type: 'message', role: 'developer', content: 'developer rule' },
            { role: 'user', content: 'Run a read-only command.' }
        ];

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                instructions: 'base rule',
                input
            }, true);

            expect(body.instructions).toBe('base rule');
            expect(body.input).toEqual(input);
        } finally {
            service.stopCacheCleanup();
        }
    });
});
