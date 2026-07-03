import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex auth proxy UI source', () => {
    test('new Codex OAuth authorization lets users choose a proxy before generating auth URL', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(source).toContain('async function showCodexAuthMethodSelector(providerType)');
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
        expect(source).toContain('服务器出口');
        expect(source).not.toContain('94 后端出口');
        expect(uiManagerSource).toContain('/api/proxy-pools/test');
    });
});
