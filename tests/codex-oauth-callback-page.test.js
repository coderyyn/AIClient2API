import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';

async function loadCallbackPageModule() {
    try {
        return await import('../src/auth/codex-oauth-response-page.js');
    } catch (error) {
        return null;
    }
}

describe('Codex OAuth callback page', () => {
    test('notifies the opener, retries closing, and keeps a manual close fallback', async () => {
        const module = await loadCallbackPageModule();
        const buildPage = module?.generateCodexCallbackPage;

        expect(typeof buildPage).toBe('function');
        if (typeof buildPage !== 'function') return;

        const html = buildPage({
            isSuccess: true,
            message: 'Callback received',
            sessionId: 'session-123'
        });

        expect(html).toContain('codex-oauth-callback-received');
        expect(html).toContain('openai-codex-oauth');
        expect(html).toContain('session-123');
        expect(html).toContain("window.opener.postMessage");
        expect(html).toContain("setTimeout(attemptClose, 1000)");
        expect(html).toContain('maxCloseAttempts = 5');
        expect(html).toContain('manual-close-button');
        expect(html).toContain('回调已接收');
    });

    test('escapes callback errors and does not send a success message', async () => {
        const module = await loadCallbackPageModule();
        const buildPage = module?.generateCodexCallbackPage;

        expect(typeof buildPage).toBe('function');
        if (typeof buildPage !== 'function') return;

        const html = buildPage({
            isSuccess: false,
            message: '<script>alert(1)</script>',
            sessionId: 'session-error'
        });

        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).not.toContain('codex-oauth-callback-received');
        expect(html).toContain('manual-close-button');
    });

    test('escapes session metadata before embedding it in an inline script', async () => {
        const module = await loadCallbackPageModule();
        const buildPage = module?.generateCodexCallbackPage;

        expect(typeof buildPage).toBe('function');
        if (typeof buildPage !== 'function') return;

        const html = buildPage({
            isSuccess: true,
            message: 'Callback received',
            sessionId: '</script><script>window.injected = true</script>'
        });

        expect(html.match(/<script>/g)).toHaveLength(1);
        expect(html).not.toContain('</script><script>window.injected = true</script>');
        expect(html).toContain('\\u003C/script\\u003E');
    });

    test('renders English callback copy when requested', async () => {
        const module = await loadCallbackPageModule();
        const buildPage = module?.generateCodexCallbackPage;

        const html = buildPage({
            isSuccess: true,
            sessionId: 'session-en',
            locale: 'en'
        });

        expect(html).toContain('Callback received');
        expect(html).toContain('Credentials are being saved in the background');
        expect(html).toContain('Close this page');
    });

    test('shares callback copy with the existing browser i18n catalog', async () => {
        const catalog = await import('../static/app/codex-oauth-callback-i18n.js');
        const browserI18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(catalog.CODEX_OAUTH_CALLBACK_TRANSLATIONS['zh-CN'])
            .toHaveProperty(['oauth.codex.callback.closeButton'], '关闭此页');
        expect(catalog.CODEX_OAUTH_CALLBACK_TRANSLATIONS['en-US'])
            .toHaveProperty(['oauth.codex.callback.closeButton'], 'Close this page');
        expect(browserI18nSource).toContain("import { CODEX_OAUTH_CALLBACK_TRANSLATIONS } from './codex-oauth-callback-i18n.js';");
        expect(browserI18nSource).toContain("...CODEX_OAUTH_CALLBACK_TRANSLATIONS['zh-CN']");
        expect(browserI18nSource).toContain("...CODEX_OAUTH_CALLBACK_TRANSLATIONS['en-US']");
    });
});
