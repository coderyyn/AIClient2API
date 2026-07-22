import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex OAuth provider proxy source', () => {
    test('target provider config is merged before constructing CodexAuth', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');

        expect(source).toContain('function resolveTargetProviderConfig(currentConfig, targetProviderUuid)');
        expect(source).toContain("currentConfig.providerPools?.['openai-codex-oauth']");
        expect(source).toContain('targetProviderConfig');
        expect(source).toContain('...targetProviderConfig');
        expect(source).toContain('requestHost: options.requestHost || null');
    });

    test('reauthorization distinguishes omitted, changed, and cleared proxy selections', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');

        expect(source).toContain("Object.prototype.hasOwnProperty.call(options, 'proxyId')");
        expect(source).toContain('hasProxyOverride');
        expect(source).toContain('proxyId: selectedProxyId');
        expect(source).toContain('proxyOverrideProvided: hasProxyOverride');
    });

    test('persists credentials and proxy selection before broadcasting OAuth success', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');
        const listenerStart = source.indexOf('const handleAuthSuccess = async (result) => {');
        const persistIndex = source.indexOf('await persistCodexOAuthCredentials', listenerStart);
        const broadcastIndex = source.indexOf("broadcastEvent('oauth_success'", listenerStart);

        expect(listenerStart).toBeGreaterThan(-1);
        expect(persistIndex).toBeGreaterThan(listenerStart);
        expect(broadcastIndex).toBeGreaterThan(persistIndex);
    });

    test('manual callback errors retain target provider metadata', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');
        const callbackStart = source.indexOf('export async function handleCodexOAuthCallback');
        const callbackSource = source.slice(callbackStart);

        expect(callbackSource).toContain('let callbackTargetProviderUuid = null');
        expect(callbackSource).toContain('callbackTargetProviderUuid = claimedSession.targetProviderUuid || null');
        expect(callbackSource).toContain('targetProviderUuid: callbackTargetProviderUuid');
    });

    test('automatic and manual callbacks atomically claim one OAuth session', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');
        const handleStart = source.indexOf('export async function handleCodexOAuth');
        const automaticStart = source.indexOf('const handleAuthSuccess = async (result) => {', handleStart);
        const automaticEnd = source.indexOf('const handleAuthError = (callbackError) => {', automaticStart);
        const automaticSource = source.slice(automaticStart, automaticEnd);
        const manualStart = source.indexOf('export async function handleCodexOAuthCallback');
        const manualSource = source.slice(manualStart);

        expect(source).toContain('function claimCodexOAuthSession(sessionId)');
        expect(automaticSource.indexOf('claimCodexOAuthSession(sessionId)')).toBeGreaterThan(-1);
        expect(automaticSource.indexOf('claimCodexOAuthSession(sessionId)'))
            .toBeLessThan(automaticSource.indexOf('completeOAuthFlow'));
        expect(manualSource.indexOf('claimCodexOAuthSession(state)')).toBeGreaterThan(-1);
        expect(manualSource.indexOf('claimCodexOAuthSession(state)'))
            .toBeLessThan(manualSource.indexOf('completeOAuthFlow'));
    });

    test('validates callback state before claiming the current OAuth session', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');
        const handleStart = source.indexOf('export async function handleCodexOAuth');
        const automaticStart = source.indexOf('const handleAuthSuccess = async (result) => {', handleStart);
        const automaticEnd = source.indexOf('const handleAuthError = (callbackError) => {', automaticStart);
        const automaticSource = source.slice(automaticStart, automaticEnd);

        expect(automaticSource).toContain('if (!result || result.state !== sessionId)');
        expect(automaticSource.indexOf('if (!result || result.state !== sessionId)'))
            .toBeLessThan(automaticSource.indexOf('claimCodexOAuthSession(sessionId)'));
        expect(source).toContain("server.emit('auth-error', {");
        expect(source).toContain('state');
    });

    test('reauthorization never overwrites the active credential file before provider persistence', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');
        const handleStart = source.indexOf('export async function handleCodexOAuth');
        const handleEnd = source.indexOf('export async function handleCodexOAuthCallback', handleStart);
        const handleSource = source.slice(handleStart, handleEnd);
        const persistStart = source.indexOf('async function persistCodexOAuthCredentials');
        const persistEnd = source.indexOf('function resolveTargetProviderConfig', persistStart);
        const persistSource = source.slice(persistStart, persistEnd);

        expect(handleSource).toContain('delete authConfig.CODEX_OAUTH_CREDS_FILE_PATH');
        expect(persistSource).toContain('await removeCodexOAuthCredentialFile(credentials.credPath)');
        expect(persistSource.indexOf('await replaceProviderCredentialPath'))
            .toBeLessThan(persistSource.indexOf('await removeCodexOAuthCredentialFile(credentials.credPath)'));
        expect(persistSource).toContain('throwOnPersistError: true');
    });

    test('authorization timeout closes the callback server and broadcasts a terminal error', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');
        const timeoutStart = source.indexOf('if (pollCount >= maxPollCount && !isCompleted)');
        const timeoutEnd = source.indexOf('// 将 pollTimer 存储到会话中', timeoutStart);
        const timeoutSource = source.slice(timeoutStart, timeoutEnd);

        expect(timeoutSource).toContain('claimCodexOAuthSession(sessionId)');
        expect(timeoutSource).toContain('closeCodexOAuthServer');
        expect(timeoutSource).toContain("broadcastEvent('oauth_error'");
        expect(timeoutSource).toContain('targetProviderUuid');
    });
});
