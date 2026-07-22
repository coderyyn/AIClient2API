import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';
import { EventEmitter } from 'events';

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn(),
    replaceProviderCredentialPath: jest.fn()
}));

jest.mock('../src/core/config-manager.js', () => ({
    CONFIG: {}
}));

jest.mock('../src/utils/tls-sidecar.js', () => ({
    getTLSSidecar: jest.fn(() => ({
        isReady: jest.fn(() => false),
        wrapAxiosConfig: jest.fn()
    }))
}));

import { broadcastEvent } from '../src/services/ui-manager.js';
import { autoLinkProviderConfigs, replaceProviderCredentialPath } from '../src/services/service-manager.js';
import {
    assertCodexOAuthProxyAvailable,
    createCodexOAuthAxiosConfig,
    handleCodexOAuth,
    handleCodexOAuthCallback
} from '../src/auth/codex-oauth.js';

let tempDir = null;
const originalCwd = process.cwd();

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    if (global.codexOAuthSessions) {
        for (const session of global.codexOAuthSessions.values()) {
            if (session?.pollTimer) clearInterval(session.pollTimer);
            if (session?.server?.listening) session.server.close();
        }
    }
    delete global.codexOAuthSessions;
    delete global.codexOAuthLatestSessionId;
    process.chdir(originalCwd);
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
    jest.useRealTimers();
});

function writeProxyPools(pools) {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-codex-oauth-proxy-${Date.now()}-`), { recursive: true });
    const filePath = join(tempDir, 'proxy-pools.json');
    writeFileSync(filePath, JSON.stringify(pools, null, 2), 'utf8');
    return filePath;
}

function setOAuthSession(sessionId, overrides = {}) {
    global.codexOAuthSessions = new Map([[sessionId, {
        auth: {
            completeOAuthFlow: jest.fn()
        },
        state: sessionId,
        pkce: { verifier: 'verifier' },
        targetProviderUuid: 'provider-1',
        proxyId: 'proxy-old',
        proxyOverrideProvided: false,
        pollTimer: null,
        server: { listening: false },
        ...overrides
    }]]);
}

function createMockCallbackServer(onListen = callback => callback()) {
    const server = new EventEmitter();
    server.listening = false;
    server.listen = jest.fn((_port, callback) => {
        server.listening = true;
        onListen(callback);
    });
    server.close = jest.fn(callback => {
        server.listening = false;
        callback?.();
    });
    return server;
}

describe('Codex OAuth proxy selection validation', () => {
    test('accepts direct access and enabled proxy nodes', () => {
        const proxyPoolsPath = writeProxyPools([
            { id: 'proxy-enabled', url: 'http://127.0.0.1:7890', enabled: true }
        ]);

        expect(assertCodexOAuthProxyAvailable({ PROXY_POOLS_FILE_PATH: proxyPoolsPath }, '')).toBeNull();
        expect(assertCodexOAuthProxyAvailable({ PROXY_POOLS_FILE_PATH: proxyPoolsPath }, 'proxy-enabled')).toMatchObject({
            id: 'proxy-enabled',
            enabled: true
        });
    });

    test('uses the selected proxy for new authorization and bypasses every proxy for explicit direct access', () => {
        const proxied = createCodexOAuthAxiosConfig({}, {
            selectedProxyUrl: 'http://127.0.0.1:7890'
        });
        const direct = createCodexOAuthAxiosConfig({
            PROXY_URL: 'http://127.0.0.1:7891',
            PROXY_ENABLED_PROVIDERS: ['openai-codex-oauth']
        }, {
            forceDirect: true
        });

        expect(proxied.proxy).toBe(false);
        expect(proxied.httpAgent).toBeDefined();
        expect(proxied.httpsAgent).toBeDefined();
        expect(direct.proxy).toBe(false);
        expect(direct.httpAgent).toBeUndefined();
        expect(direct.httpsAgent).toBeUndefined();
    });

    test.each([
        ['missing', []],
        ['disabled', [{ id: 'proxy-disabled', url: 'http://127.0.0.1:7890', enabled: false }]],
        ['unsupported', [{ id: 'proxy-unsupported', url: 'ftp://127.0.0.1:21', enabled: true }]]
    ])('rejects %s proxy nodes before starting OAuth', (_label, pools) => {
        const proxyPoolsPath = writeProxyPools(pools);
        const proxyId = pools[0]?.id || 'proxy-missing';

        expect(() => assertCodexOAuthProxyAvailable({ PROXY_POOLS_FILE_PATH: proxyPoolsPath }, proxyId))
            .toThrow(`Selected proxy node is unavailable: ${proxyId}`);
    });

    test.each([null, false, 0, {}, []])('rejects a non-string proxy override: %p', async proxyId => {
        await expect(handleCodexOAuth({}, {
            targetProviderUuid: 'provider-1',
            proxyId
        })).resolves.toMatchObject({
            success: false,
            error: 'proxyId must be a string when provided'
        });
    });

    test('an already-claimed or expired manual callback does not broadcast a second terminal event', async () => {
        global.codexOAuthSessions = new Map();

        const result = await handleCodexOAuthCallback('code', 'session-already-claimed');

        expect(result).toMatchObject({ success: false });
        expect(broadcastEvent).not.toHaveBeenCalled();
    });

    test('broadcasts OAuth success only after provider persistence resolves', async () => {
        const credentials = {
            credPath: 'C:/tmp/codex-account.json',
            relativePath: 'configs/codex/codex-account.json',
            email: 'user@example.com',
            account_id: 'account-1'
        };
        let resolvePersistence;
        let markPersistenceStarted;
        const persistenceStarted = new Promise(resolve => {
            markPersistenceStarted = resolve;
        });
        replaceProviderCredentialPath.mockImplementationOnce(() => {
            markPersistenceStarted();
            return new Promise(resolve => {
                resolvePersistence = resolve;
            });
        });
        setOAuthSession('session-persist-order', {
            auth: {
                completeOAuthFlow: jest.fn().mockResolvedValue(credentials)
            }
        });

        const callbackResult = handleCodexOAuthCallback('code', 'session-persist-order');
        await persistenceStarted;

        expect(broadcastEvent).not.toHaveBeenCalledWith('oauth_success', expect.anything());

        resolvePersistence({ updated: true });
        await expect(callbackResult).resolves.toMatchObject({ success: true });
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_success', expect.objectContaining({
            sessionId: 'session-persist-order',
            targetProviderUuid: 'provider-1'
        }));
    });

    test.each([
        ['keeps the existing proxy when omitted', false, 'proxy-old', undefined],
        ['persists a changed proxy', true, 'proxy-new', 'proxy-new'],
        ['clears the proxy for direct access', true, '', '']
    ])('%s', async (_label, proxyOverrideProvided, proxyId, expectedProxyId) => {
        replaceProviderCredentialPath.mockResolvedValueOnce({ updated: true });
        setOAuthSession(`session-proxy-${String(expectedProxyId)}`, {
            auth: {
                completeOAuthFlow: jest.fn().mockResolvedValue({
                    credPath: 'C:/tmp/codex-account.json',
                    relativePath: 'configs/codex/codex-account.json'
                })
            },
            proxyOverrideProvided,
            proxyId
        });

        await handleCodexOAuthCallback('code', `session-proxy-${String(expectedProxyId)}`);

        const persistOptions = replaceProviderCredentialPath.mock.calls[0][1];
        if (expectedProxyId === undefined) {
            expect(persistOptions).not.toHaveProperty('proxyId');
        } else {
            expect(persistOptions).toHaveProperty('proxyId', expectedProxyId);
        }
    });

    test('deletes a new credential and emits only OAuth error when provider persistence fails', async () => {
        tempDir = mkdirSync(join(tmpdir(), `aiclient2api-codex-oauth-persist-${Date.now()}-`), { recursive: true });
        process.chdir(tempDir);
        const credentialDir = join(tempDir, 'configs', 'codex');
        mkdirSync(credentialDir, { recursive: true });
        const credentialPath = join(credentialDir, 'new-account.json');
        writeFileSync(credentialPath, '{}', 'utf8');
        replaceProviderCredentialPath.mockRejectedValueOnce(new Error('provider pool write failed'));
        setOAuthSession('session-persist-failed', {
            auth: {
                completeOAuthFlow: jest.fn().mockResolvedValue({
                    credPath: credentialPath,
                    relativePath: 'configs/codex/new-account.json'
                })
            }
        });

        const result = await handleCodexOAuthCallback('code', 'session-persist-failed');

        expect(result).toMatchObject({ success: false, error: 'provider pool write failed' });
        expect(existsSync(credentialPath)).toBe(false);
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            sessionId: 'session-persist-failed',
            targetProviderUuid: 'provider-1',
            error: 'provider pool write failed'
        }));
        expect(broadcastEvent).not.toHaveBeenCalledWith('oauth_success', expect.anything());
        expect(autoLinkProviderConfigs).not.toHaveBeenCalled();
    });

    test('a newer authorization linearizes before an older in-flight callback can persist', async () => {
        tempDir = mkdirSync(join(tmpdir(), `aiclient2api-codex-oauth-generation-${Date.now()}-`), { recursive: true });
        process.chdir(tempDir);
        const credentialDir = join(tempDir, 'configs', 'codex');
        mkdirSync(credentialDir, { recursive: true });
        const oldCredentialPath = join(credentialDir, 'old-callback-new-credential.json');
        writeFileSync(oldCredentialPath, '{}', 'utf8');
        const createServerSpy = jest.spyOn(http, 'createServer');
        createServerSpy.mockImplementationOnce(() => createMockCallbackServer());

        const firstAuthorization = await handleCodexOAuth({}, {
            targetProviderUuid: 'provider-1',
            proxyId: ''
        });
        const oldSessionId = firstAuthorization.authInfo.sessionId;
        const oldSession = global.codexOAuthSessions.get(oldSessionId);
        let resolveOldExchange;
        oldSession.auth.completeOAuthFlow = jest.fn(() => new Promise(resolve => {
            resolveOldExchange = resolve;
        }));

        const oldCallback = handleCodexOAuthCallback('old-code', oldSessionId);
        let finishSecondServerListen;
        let markSecondGenerationStarted;
        const secondGenerationStarted = new Promise(resolve => {
            markSecondGenerationStarted = resolve;
        });
        createServerSpy.mockImplementationOnce(() => createMockCallbackServer(callback => {
                finishSecondServerListen = callback;
                markSecondGenerationStarted();
        }));
        const secondAuthorizationPromise = handleCodexOAuth({}, {
            targetProviderUuid: 'provider-1',
            proxyId: ''
        });
        await secondGenerationStarted;

        resolveOldExchange({
            credPath: oldCredentialPath,
            relativePath: 'configs/codex/old-callback-new-credential.json'
        });
        await Promise.resolve();
        expect(replaceProviderCredentialPath).not.toHaveBeenCalled();

        finishSecondServerListen();
        const secondAuthorization = await secondAuthorizationPromise;
        const oldResult = await oldCallback;

        expect(secondAuthorization).toMatchObject({ success: true });
        expect(oldResult).toMatchObject({
            success: false,
            error: 'OAuth authorization was replaced by a newer request'
        });
        expect(existsSync(oldCredentialPath)).toBe(false);
        expect(replaceProviderCredentialPath).not.toHaveBeenCalled();
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            sessionId: oldSessionId,
            targetProviderUuid: 'provider-1',
            error: 'OAuth authorization was replaced by a newer request'
        }));
        expect(broadcastEvent).not.toHaveBeenCalledWith('oauth_success', expect.objectContaining({
            sessionId: oldSessionId
        }));
    });

    test('a replaced authorization does not leave an orphan polling interval', async () => {
        jest.useFakeTimers();
        const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
        tempDir = mkdirSync(join(tmpdir(), `aiclient2api-codex-oauth-overlap-${Date.now()}-`), { recursive: true });
        process.chdir(tempDir);

        let finishFirstServerListen;
        let markFirstServerStarted;
        const firstServerStarted = new Promise(resolve => {
            markFirstServerStarted = resolve;
        });
        const createServerSpy = jest.spyOn(http, 'createServer');
        createServerSpy
            .mockImplementationOnce(() => createMockCallbackServer(callback => {
                finishFirstServerListen = callback;
                markFirstServerStarted();
            }))
            .mockImplementationOnce(() => createMockCallbackServer());

        const firstAuthorizationPromise = handleCodexOAuth({}, {
            targetProviderUuid: 'provider-1',
            proxyId: ''
        });
        await firstServerStarted;

        const secondAuthorizationPromise = handleCodexOAuth({}, {
            targetProviderUuid: 'provider-1',
            proxyId: ''
        });
        finishFirstServerListen();

        const [firstAuthorization, secondAuthorization] = await Promise.all([
            firstAuthorizationPromise,
            secondAuthorizationPromise
        ]);

        expect(firstAuthorization).toMatchObject({ success: true });
        expect(secondAuthorization).toMatchObject({ success: true });
        expect(global.codexOAuthSessions.size).toBe(1);
        expect(global.codexOAuthSessions.has(secondAuthorization.authInfo.sessionId)).toBe(true);
        expect(setIntervalSpy).toHaveBeenCalledTimes(2);
        expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0].value);
    });
});
