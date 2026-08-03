import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Gemini OAuth proxy and reauthorization UI', () => {
    test('Gemini CLI and Antigravity share the account proxy selector and preflight', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('async function showGeminiAuthMethodSelector(providerType, context = {})');
        expect(source).toContain('geminiAuthProxySelect');
        expect(source).toContain('geminiAuthProxyTestButton');
        expect(source).toContain("window.apiClient.post('/proxy-pools/test', { proxyId })");
        expect(source).toContain('executeGenerateAuthUrl(providerType, { proxyId })');
        expect(source).toContain('executeGenerateAuthUrl(providerType, { targetProviderUuid, proxyId })');
    });

    test('provider cards expose in-place Gemini reauthorization with the existing proxy selected', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(modalSource).toContain("['openai-codex-oauth', 'gemini-cli-oauth', 'gemini-antigravity'].includes(currentProviderType)");
        expect(modalSource).toContain('window.showGeminiAuthMethodSelector(providerType, {');
        expect(modalSource).toContain("mode: 'reauthorize'");
        expect(modalSource).toContain('initialProxyId: currentProvider.PROXY_ID ||');
        expect(providerSource).toContain('window.showGeminiAuthMethodSelector = showGeminiAuthMethodSelector');
    });

    test('Gemini proxy and reauthorization strings are localized in both languages', () => {
        const source = readFileSync('static/app/i18n.js', 'utf8');

        expect(source.match(/'oauth\.gemini\.proxyLabel'/g)).toHaveLength(2);
        expect(source.match(/'oauth\.gemini\.proxyTest'/g)).toHaveLength(2);
        expect(source.match(/'oauth\.gemini\.reauthorizeTitle'/g)).toHaveLength(2);
    });
});
