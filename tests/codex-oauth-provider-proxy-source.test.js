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
});
