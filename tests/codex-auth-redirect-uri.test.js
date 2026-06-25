import { describe, expect, test } from '@jest/globals';
import { buildCodexRedirectUri } from '../src/utils/codex-utils.js';

describe('Codex OAuth redirect URI', () => {
    test('uses the current server host and fixed callback port', () => {
        expect(buildCodexRedirectUri('47.77.196.94:3000')).toBe('http://47.77.196.94:1455/auth/callback');
        expect(buildCodexRedirectUri('codex.example.com')).toBe('http://codex.example.com:1455/auth/callback');
    });

    test('falls back to localhost when no usable host is provided', () => {
        expect(buildCodexRedirectUri('')).toBe('http://localhost:1455/auth/callback');
        expect(buildCodexRedirectUri(null)).toBe('http://localhost:1455/auth/callback');
    });
});
