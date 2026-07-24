import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex auth proxy UI source', () => {
    test('new Codex OAuth authorization lets users choose a proxy before generating auth URL', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('async function showCodexAuthMethodSelector(providerType, context = {})');
        expect(source).toContain('/proxy-pools');
        expect(source).toContain('codexAuthProxySelect');
        expect(source).toContain('proxyId');
        expect(source).toContain('executeGenerateAuthUrl(providerType, { proxyId })');
    });

    test('new Codex OAuth authorization can preflight browser and server proxy exits', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');
        const uiManagerSource = readFileSync('src/services/ui-manager.js', 'utf8');

        expect(source).toContain('codexAuthProxyTestButton');
        expect(source).toContain('testCodexAuthProxy');
        expect(source).toContain('https://api.ipify.org?format=json');
        expect(source).toContain('/proxy-pools/test');
        expect(source).toContain('browserIp');
        expect(source).toContain('serverIp');
        expect(source).toContain('data-proxy-name');
        expect(source).toContain("t('oauth.codex.proxyServerExit')");
        expect(source).not.toContain('94 后端出口');
        expect(uiManagerSource).toContain('/api/proxy-pools/test');
    });

    test('proxy preflight bounds the browser lookup and runs both exit probes in parallel', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(source).toContain('const controller = new AbortController()');
        expect(source).toContain('setTimeout(() => controller.abort(), 12000)');
        expect(source).toContain('signal: controller.signal');
        expect(source).toContain('clearTimeout(timeoutId)');
        expect(source).toContain('await Promise.allSettled([');
        expect(i18nSource.match(/'oauth\.codex\.proxyBrowserExitTimeout'/g)).toHaveLength(2);
    });

    test('proxy preflight renders network failures as failed instead of mismatched', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('function renderProxyTestLine(label, ip, error, expectedIp)');
        expect(source).toContain("const badge = error ? t('oauth.codex.proxyTestFailed')");
        expect(source).toContain("renderProxyTestLine(t('oauth.codex.proxyBrowserExit'), browserIp, browserError, expectedIp)");
        expect(source).toContain("renderProxyTestLine(t('oauth.codex.proxyServerExit'), serverIp, serverError, expectedIp)");
    });

    test('Codex create and reauthorization modes reuse one proxy selector implementation', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('async function loadCodexAuthProxyChoices');
        expect(source).toContain('function renderCodexAuthProxySection');
        expect(source).toContain('function bindCodexAuthProxyControls');
        expect(source).toContain('showCodexAuthMethodSelector(providerType, context = {})');
    });

    test('new Codex proxy UI strings are localized in Chinese and English', () => {
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(i18nSource.match(/'oauth\.codex\.proxyLabel'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyTest'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.reauthorizeTitle'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.currentProxyUnavailable'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyLoadErrorCreate'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyLoadErrorReauthorize'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.currentProxyPreserved'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyTesting'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyBrowserExit'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyServerExit'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.codex\.proxyMismatch'/g)).toHaveLength(2);
    });

    test('proxy load failures preserve unknown current state without calling it unavailable', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain("const missingCurrentProxyKey = loadError");
        expect(source).toContain("? 'oauth.codex.currentProxyPreserved'");
        expect(source).toContain("const loadErrorKey = isReauthorize");
        expect(source).toContain("? 'oauth.codex.proxyLoadErrorReauthorize'");
    });

    test('proxy preflight locks selection and authorization controls until the result is current', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('let isProxyTestRunning = false');
        expect(source).toContain('select.disabled = selectInitiallyDisabled || isBusy || isProxyTestRunning');
        expect(source).toContain('methodButtons.forEach(button =>');
        expect(source).toContain('isProxyTestRunning = true');
        expect(source).toContain('isProxyTestRunning = false');
        expect(source).toContain('setBusy: (busy) =>');
    });

    test('shows one loading selector immediately while proxy nodes are being fetched', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');
        const appendIndex = source.indexOf('document.body.appendChild(modal)', source.indexOf('async function showCodexAuthMethodSelector'));
        const loadIndex = source.indexOf('await loadCodexAuthProxyChoices(initialProxyId)', source.indexOf('async function showCodexAuthMethodSelector'));

        expect(source).toContain("document.querySelector('.codex-auth-selector-modal')");
        expect(source).toContain('codex-auth-selector-modal');
        expect(source).toContain("t('oauth.codex.proxyLoading')");
        expect(appendIndex).toBeGreaterThan(-1);
        expect(loadIndex).toBeGreaterThan(appendIndex);
        expect(i18nSource.match(/'oauth\.codex\.proxyLoading'/g)).toHaveLength(2);
    });

    test('clears the unavailable-current-proxy warning after a valid choice', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('codexAuthCurrentProxyWarning');
        expect(source).toContain('currentProxyWarning.style.display');
    });
});
