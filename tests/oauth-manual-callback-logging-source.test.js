import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('manual OAuth callback logging', () => {
    test('does not log callback URLs containing OAuth codes or state', () => {
        const source = readFileSync('src/ui-modules/oauth-api.js', 'utf8');

        expect(source).not.toContain('Callback URL: ${callbackUrl}');
        expect(source).not.toContain('Sending request to local server: ${localUrl.href}');
        expect(source).not.toContain('Callback processing failed:`, errorText');
        expect(source).not.toContain('Failed to process callback:`, fetchError');
        expect(source).not.toContain("logger.error('[OAuth Manual Callback] Error:', error)");
        expect(source).toContain('Processing manual callback for ${provider}');
    });

    test('does not log the full Codex authorization URL containing state and PKCE metadata', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');

        expect(source).not.toContain('If browser doesn\'t open, visit: ${authUrl.toString()}');
    });
});
