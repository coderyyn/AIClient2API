import { describe, expect, test } from '@jest/globals';

import {
    ANTIGRAVITY_DEFAULT_USER_AGENT,
    parseAntigravityUserAgentVersion
} from '../src/providers/gemini/antigravity-version.js';

describe('Antigravity client identity', () => {
    test('defaults to the legacy user agent, not a Hub one', () => {
        expect(ANTIGRAVITY_DEFAULT_USER_AGENT).toBe('antigravity/2.9.1 darwin/arm64');
    });

    test('extracts the version from every Antigravity user agent shape', () => {
        expect(parseAntigravityUserAgentVersion('antigravity/2.9.1 darwin/arm64')).toBe('2.9.1');
        expect(parseAntigravityUserAgentVersion('antigravity/hub/2.23.0 darwin/arm64')).toBe('2.23.0');
        expect(parseAntigravityUserAgentVersion('antigravity/cli/1.3.1 (aidev_client; os_type=darwin; arch=arm64)')).toBe('1.3.1');
        expect(parseAntigravityUserAgentVersion('Mozilla/5.0')).toBe('');
        expect(parseAntigravityUserAgentVersion(undefined)).toBe('');
    });
});
