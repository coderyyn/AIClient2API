import { classifyRuntimeRequest, resolveWorkerTopology } from '../src/runtime/worker-topology.js';

describe('runtime worker topology', () => {
    test('defaults to one control and three execution workers', () => {
        expect(resolveWorkerTopology({})).toEqual({ controlWorkers: 1, executionWorkers: 3 });
        expect(resolveWorkerTopology({ RUNTIME_EXECUTION_WORKERS: '4' }).executionWorkers).toBe(4);
    });

    test('routes only model traffic to execution workers', () => {
        expect(classifyRuntimeRequest('POST', '/v1/chat/completions')).toBe('execution');
        expect(classifyRuntimeRequest('POST', '/openai-codex-oauth/v1/responses')).toBe('execution');
        expect(classifyRuntimeRequest('POST', '/v1/images/generations')).toBe('execution');
        expect(classifyRuntimeRequest('GET', '/v1/models')).toBe('execution');
        expect(classifyRuntimeRequest('GET', '/api/usage')).toBe('control');
        expect(classifyRuntimeRequest('GET', '/')).toBe('control');
    });
});
