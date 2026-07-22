import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex OAuth proxy source contract', () => {
    test('constructs the OAuth token refresh client through config managed proxy helper', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');

        expect(source).toContain("import { configureAxiosProxy, parseProxyUrl } from '../utils/proxy-utils.js';");
        expect(source).toContain("return configureAxiosProxy(axiosConfig, config, 'openai-codex-oauth');");
    });

    test('an explicit empty proxy selection forces this OAuth session to connect directly', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');

        expect(source).toContain('export function createCodexOAuthAxiosConfig(config = {}, options = {})');
        expect(source).toContain('if (options.forceDirect)');
        expect(source).toContain('axiosConfig.proxy = false');
        expect(source).toContain('forceDirect: hasProxyOverride && !selectedProxyId');
    });
});
