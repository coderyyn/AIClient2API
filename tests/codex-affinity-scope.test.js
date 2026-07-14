import { describe, expect, jest, test } from '@jest/globals';
import { resolveCodexAffinityKey } from '../src/services/service-manager.js';
import { extractCodexCacheAffinityScope } from '../src/utils/common.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    serviceInstances: {},
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth'])
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

describe('Codex affinity scope', () => {
    test('prefers conversation cache scope over the distributed Potluck key', () => {
        const affinity = resolveCodexAffinityKey({
            CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
            potluckApiKey: 'maki_secret_key',
            _codexCacheAffinityScope: {
                promptCacheKey: 'prompt-cache-thread-a',
                threadId: 'thread-a',
                sessionId: 'session-a'
            }
        }, 'openai-codex-oauth', 'gpt-image-2');

        expect(affinity).toMatchObject({
            source: 'prompt_cache_key'
        });
        expect(affinity.key).toMatch(/^prompt-cache:[a-f0-9]{16}$/);
        expect(affinity.key).not.toContain('prompt-cache-thread-a');
        expect(affinity.key).not.toContain('maki_secret_key');
    });

    test('falls back to Potluck key and model when no conversation cache scope exists', () => {
        const affinity = resolveCodexAffinityKey({
            CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
            potluckApiKey: 'maki_secret_key'
        }, 'openai-codex-oauth', 'gpt-image-2');

        expect(affinity).toMatchObject({
            source: 'potluck_key'
        });
        expect(affinity.key).toMatch(/^potluck:[a-f0-9]{16}:model:gpt-image-2$/);
        expect(affinity.key).not.toContain('maki_secret_key');
    });

    test('does not create affinity for non-Codex providers', () => {
        expect(resolveCodexAffinityKey({
            CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
            potluckApiKey: 'maki_secret_key'
        }, 'gemini-cli-oauth', 'gpt-image-2')).toBeNull();
    });

    test('merges Codex client metadata with request metadata', () => {
        const scope = extractCodexCacheAffinityScope({
            client_metadata: {
                session_id: 'codex-cli-session-a',
                'x-codex-turn-metadata': JSON.stringify({
                    request_id: 'turn-request-a'
                })
            },
            metadata: {
                prompt_cache_key: 'codex-cache-thread-a'
            }
        });

        expect(scope).toEqual({
            promptCacheKey: 'codex-cache-thread-a',
            sessionId: 'codex-cli-session-a',
            turnId: 'turn-request-a'
        });
    });
});
