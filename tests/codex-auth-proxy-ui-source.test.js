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
});
