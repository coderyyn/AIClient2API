import { readFileSync } from 'fs';

describe('provider proxy UI source', () => {
    test('Codex provider edit fields expose only centralized proxy selection', () => {
        const source = readFileSync('static/app/utils.js', 'utf8');

        const codexSection = source.slice(
            source.indexOf("'openai-codex-oauth': ["),
            source.indexOf("'grok-cli-oauth': [")
        );

        expect(codexSection).not.toContain("id: 'PROXY_URL'");
        expect(codexSection).not.toContain("id: 'PROXY_REQUIRED'");
        expect(codexSection).toContain("id: 'PROXY_ID'");
        expect(codexSection).toContain("type: 'proxy-select'");
    });

    test('shared provider proxy fields no longer render legacy per-node proxy URL or required toggle', () => {
        const source = readFileSync('static/app/utils.js', 'utf8');
        const proxyFieldsSection = source.slice(
            source.indexOf('const providerProxyFields = ['),
            source.indexOf('const withProviderProxyFields')
        );

        expect(proxyFieldsSection).not.toContain("id: 'PROXY_URL'");
        expect(proxyFieldsSection).not.toContain("id: 'PROXY_REQUIRED'");
        expect(proxyFieldsSection).toContain("id: 'PROXY_ID'");
        expect(proxyFieldsSection).toContain("type: 'proxy-select'");
    });
});
