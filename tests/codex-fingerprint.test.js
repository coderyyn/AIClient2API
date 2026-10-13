import { describe, expect, test } from '@jest/globals';
import {
    applyCodexFingerprintClientMetadata,
    applyCodexFingerprintHeaders,
    bindCodexFingerprintConversation,
    resolveCodexFingerprintIds,
    resolveCodexFingerprintMode
} from '../src/providers/openai/codex-fingerprint.js';

function provider(overrides = {}) {
    return {
        MODEL_PROVIDER: 'openai-codex-oauth',
        uuid: 'provider-a',
        codexAccountKey: 'account-a',
        ...overrides
    };
}

describe('Codex OAuth fingerprint convergence', () => {
    test('defaults Codex OAuth providers to off and honors explicit per-credential modes', () => {
        expect(resolveCodexFingerprintMode(provider())).toBe('off');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'bogus' }))).toBe('off');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'off' }))).toBe('off');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'device' }))).toBe('device');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'session' }))).toBe('session');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'full' }))).toBe('full');
        expect(resolveCodexFingerprintMode({ MODEL_PROVIDER: 'openai-custom', codexFingerprintMode: 'session' })).toBe('off');
        expect(resolveCodexFingerprintIds({ providerConfig: provider() })).toBeNull();
    });

    test('derives stable account ids and session-scoped threads', () => {
        const first = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a'
        });
        const repeated = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a'
        });
        const otherClient = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-b'
        });
        const otherAccount = resolveCodexFingerprintIds({
            providerConfig: provider({ uuid: 'provider-b', codexAccountKey: 'account-b', codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a'
        });

        expect(first.installationId).toBe(repeated.installationId);
        expect(first.sessionId).toBe(repeated.sessionId);
        expect(first.threadId).toBe(repeated.threadId);
        expect(first.turnId).not.toBe(repeated.turnId);
        expect(first.sessionId).toBe(first.threadId);
        expect(first.threadId).not.toBe(otherClient.threadId);
        expect(first.installationId).not.toBe(otherAccount.installationId);
        expect(first.sessionId).not.toBe(otherAccount.sessionId);
    });

    test('keeps a rewritten turn ID stable when the client supplies the same original turn', () => {
        const options = {
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a',
            originalTurnId: 'client-turn-a'
        };
        expect(resolveCodexFingerprintIds(options).turnId).toBe(resolveCodexFingerprintIds(options).turnId);
        expect(resolveCodexFingerprintIds(options).turnId).not.toBe(resolveCodexFingerprintIds({ ...options, originalTurnId: 'client-turn-b' }).turnId);
    });

    test('full mode converges threads while device mode only changes installation identity', () => {
        const fullA = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'full' }),
            originalClientSessionId: 'client-a'
        });
        const fullB = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'full' }),
            originalClientSessionId: 'client-b'
        });
        const device = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'device' }),
            originalClientSessionId: 'client-a'
        });

        expect(fullA.threadId).toBe(fullA.sessionId);
        expect(fullB.threadId).toBe(fullA.threadId);
        expect(device.installationId).toBeTruthy();
        expect(device.sessionId).toBeNull();
        expect(device.threadId).toBeNull();

        const headers = {
            'x-codex-installation-id': 'original-installation',
            'session-id': 'original-session',
            session_id: 'original-session-underscore',
            'thread-id': 'original-thread'
        };
        applyCodexFingerprintHeaders(headers, device);
        // 原生 Codex 不以请求头发送 installation id，改写后只保留在 client_metadata。
        expect(headers['x-codex-installation-id']).toBeUndefined();
        expect(headers['session-id']).toBe('original-session');
        expect(headers.session_id).toBe('original-session-underscore');
        expect(headers['thread-id']).toBe('original-thread');
    });

    test('rewrites headers and client metadata with one shared id set', () => {
        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a'
        });
        const headers = {
            'x-codex-turn-metadata': JSON.stringify({ sandbox: 'workspace-write', turn_id: 'old-turn' })
        };
        const body = {
            client_metadata: {
                sandbox: 'workspace-write',
                'x-codex-turn-metadata': JSON.stringify({ thread_source: 'cli', turn_id: 'old-turn' })
            }
        };

        applyCodexFingerprintHeaders(headers, ids);
        applyCodexFingerprintClientMetadata(body, ids);

        const headerMetadata = JSON.parse(headers['x-codex-turn-metadata']);
        const bodyMetadata = JSON.parse(body.client_metadata['x-codex-turn-metadata']);
        expect(headers['x-codex-installation-id']).toBeUndefined();
        expect(body.client_metadata['x-codex-installation-id']).toBe(ids.installationId);
        expect(headers['session-id']).toBe(ids.sessionId);
        expect(headers['Session-Id']).toBeUndefined();
        expect(headers['thread-id']).toBe(ids.threadId);
        expect(body.client_metadata.session_id).toBe(ids.sessionId);
        expect(body.client_metadata.thread_id).toBe(ids.threadId);
        expect(headerMetadata.turn_id).toBe(ids.turnId);
        expect(bodyMetadata.turn_id).toBe(ids.turnId);
        expect(headerMetadata.sandbox).toBe('workspace-write');
        expect(bodyMetadata.thread_source).toBe('cli');
    });

    test('fails open for malformed embedded metadata and off mode leaves inputs unchanged', () => {
        const headers = { 'x-codex-turn-metadata': '{bad-json', 'session-id': 'original' };
        const body = { client_metadata: { 'x-codex-turn-metadata': '{bad-json', session_id: 'original' } };
        const originalHeaders = structuredClone(headers);
        const originalBody = structuredClone(body);

        applyCodexFingerprintHeaders(headers, null);
        applyCodexFingerprintClientMetadata(body, null);

        expect(headers).toEqual(originalHeaders);
        expect(body).toEqual(originalBody);

        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client'
        });
        expect(() => applyCodexFingerprintHeaders(headers, ids)).not.toThrow();
        expect(() => applyCodexFingerprintClientMetadata(body, ids)).not.toThrow();
        expect(headers['x-codex-turn-metadata']).toBe('{bad-json');
        expect(body.client_metadata['x-codex-turn-metadata']).toBe('{bad-json');
    });

    test('removes case-insensitive header collisions before applying converged IDs', () => {
        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client'
        });
        const headers = {
            Session_id: 'cache-session',
            SESSION_ID: 'legacy-session',
            'X-Codex-Installation-Id': 'legacy-installation'
        };

        applyCodexFingerprintHeaders(headers, ids);

        expect(headers.Session_id).toBeUndefined();
        expect(headers.SESSION_ID).toBeUndefined();
        expect(headers['X-Codex-Installation-Id']).toBeUndefined();
        expect(headers['session-id']).toBe(ids.sessionId);
        expect(headers.session_id).toBeUndefined();
        expect(headers['x-codex-installation-id']).toBeUndefined();
    });

    test('matches native Codex ID shapes: v4 installation, v7 session/thread/turn, root turn and window number', () => {
        const nativeThread = '019a1b2c-3d4e-7f00-8a1b-2c3d4e5f6a7b';
        const nativeTurn = '019a1b2c-4000-7abc-9def-0123456789ab';
        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: nativeThread,
            originalTurnId: nativeTurn,
            windowNumber: 2
        });
        const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

        expect(ids.installationId).toMatch(v4);
        expect(ids.sessionId).toMatch(v7);
        expect(ids.threadId).toBe(ids.sessionId);
        expect(ids.turnId).toMatch(v7);
        expect(ids.rootTurnId).toBe(ids.turnId);
        expect(ids.windowId).toBe(`${ids.threadId}:2`);
        // 派生 ID 继承来源 v7 的时间戳，与原生会话时间一致，但不暴露原值。
        expect(ids.threadId.slice(0, 13)).toBe(nativeThread.slice(0, 13));
        expect(ids.threadId).not.toBe(nativeThread);
        expect(ids.turnId.slice(0, 13)).toBe(nativeTurn.slice(0, 13));

        const fresh = resolveCodexFingerprintIds({ providerConfig: provider({ codexFingerprintMode: 'session' }) });
        expect(fresh.turnId).toMatch(v7);
        expect(Math.abs(parseInt(fresh.turnId.replace(/-/g, '').slice(0, 12), 16) - Date.now())).toBeLessThan(60_000);
    });

    test('maps a distinct subagent root turn instead of leaking the client value', () => {
        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a',
            originalTurnId: 'child-turn',
            originalRootTurnId: 'root-turn'
        });
        const rootOnly = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            originalClientSessionId: 'client-session-a',
            originalTurnId: 'root-turn'
        });
        expect(ids.rootTurnId).not.toBe(ids.turnId);
        expect(ids.rootTurnId).toBe(rootOnly.turnId);
    });

    test('binds the conversation to the prompt cache key when the client sent no session', () => {
        const config = provider({ codexFingerprintMode: 'session' });
        const first = bindCodexFingerprintConversation(resolveCodexFingerprintIds({ providerConfig: config }), config, 'cache-a');
        const again = bindCodexFingerprintConversation(resolveCodexFingerprintIds({ providerConfig: config }), config, 'cache-a');
        const other = bindCodexFingerprintConversation(resolveCodexFingerprintIds({ providerConfig: config }), config, 'cache-b');
        const withClientSession = resolveCodexFingerprintIds({ providerConfig: config, originalClientSessionId: 'client-session-a' });
        const boundSession = withClientSession.sessionId;

        expect(first.sessionId).toBe(again.sessionId);
        expect(first.sessionId).not.toBe(other.sessionId);
        expect(first.windowId).toBe(`${first.threadId}:0`);
        expect(bindCodexFingerprintConversation(withClientSession, config, 'cache-a').sessionId).toBe(boundSession);
    });
});
