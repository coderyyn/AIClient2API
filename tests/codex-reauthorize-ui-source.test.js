import { readFileSync } from 'fs';

describe('Codex reauthorization UI wiring', () => {
    test('provider modal exposes an in-place reauthorization action', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(modalSource).toContain('reauthorizeProvider');
        expect(modalSource).toContain('targetProviderUuid');
        expect(modalSource).toContain('modal.provider.reauthorize');
        expect(providerManagerSource).toContain('targetProviderUuid');
    });

    test('reauthorization opens the dedicated Codex proxy selector with the current proxy selected', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(modalSource).toContain('currentProviders.find(provider => provider.uuid === uuid)');
        expect(modalSource).toContain('window.showCodexAuthMethodSelector(providerType, {');
        expect(modalSource).toContain("mode: 'reauthorize'");
        expect(modalSource).toContain('initialProxyId: currentProvider.PROXY_ID ||');
        expect(providerManagerSource).toContain("const isReauthorize = context.mode === 'reauthorize'");
        expect(providerManagerSource).toContain('codexReauthorizeStartButton');
        expect(providerManagerSource).toContain('executeGenerateAuthUrl(providerType, { targetProviderUuid, proxyId })');
    });

    test('reauthorization UI handles unavailable proxies and clears stale proxy test results', () => {
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerManagerSource).toContain('currentProxyUnavailable');
        expect(providerManagerSource).toContain("resultEl.style.display = 'none'");
        expect(providerManagerSource).toContain('codexAuthProxyLoadError');
        expect(providerManagerSource).toContain('preserveExistingProxy');
        expect(providerManagerSource).toContain('!loadError &&');
    });

    test('reauthorization keeps its selector open when authorization URL generation fails', () => {
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const executeStart = providerManagerSource.indexOf('async function executeGenerateAuthUrl');
        const executeEnd = providerManagerSource.indexOf('function getAuthFilePath', executeStart);
        const executeSource = providerManagerSource.slice(executeStart, executeEnd);

        expect(providerManagerSource).toContain('oauth.codex.reauthorizeStarting');
        expect(providerManagerSource).toContain('const started = preserveExistingProxy');
        expect(providerManagerSource).toContain('if (started)');
        expect(executeSource).toContain('return true');
        expect(executeSource).toContain('return false');
    });

    test('reauthorization reuses the auth modal listeners and refreshes the target account after SSE success', () => {
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerManagerSource).not.toContain('handleReauthorizeSuccess');
        expect(providerManagerSource).not.toContain('handleReauthorizeError');
        expect(providerManagerSource).toContain('authInfo.targetProviderUuid');
        expect(providerManagerSource).toContain("await window.apiClient.post('/reload-config')");
        expect(providerManagerSource).toContain('await window.refreshProviderConfig(authInfo.provider)');
    });

    test('reauthorization cannot be cancelled while its authorization URL is being generated', () => {
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerManagerSource).toContain('let isGeneratingAuthUrl = false');
        expect(providerManagerSource).toContain('closeBtn.disabled = isGeneratingAuthUrl');
        expect(providerManagerSource).toContain('cancelBtn.disabled = isGeneratingAuthUrl');
        expect(providerManagerSource).toContain('if (isGeneratingAuthUrl) return');
    });

    test('reauthorization missing-provider errors are localized', () => {
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(i18nSource.match(/'modal\.provider\.notFound'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.reauthorizeStarting'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.reauthorizeUuid'/g)).toHaveLength(2);
    });
});
