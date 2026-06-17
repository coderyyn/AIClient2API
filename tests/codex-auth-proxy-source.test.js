import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex OAuth proxy source contract', () => {
    test('constructs the OAuth token refresh client through config managed proxy helper', () => {
        const source = readFileSync('src/auth/codex-oauth.js', 'utf8');

        expect(source).toContain("import { configureAxiosProxy } from '../utils/proxy-utils.js';");
        expect(source).toContain("configureAxiosProxy(axiosConfig, config, 'openai-codex-oauth');");
    });
});
