import { readFileSync } from 'fs';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/tls-sidecar.js', () => ({
    getTLSSidecar: jest.fn(() => ({ isReady: jest.fn(() => false) }))
}));

import { getRequiredProxyConfigForProvider } from '../src/utils/proxy-utils.js';

describe('Gemini provider proxy binding', () => {
    test.each(['gemini-cli-oauth', 'gemini-antigravity'])('%s rejects an unresolved account proxy', providerType => {
        expect(() => getRequiredProxyConfigForProvider({
            uuid: `${providerType}-account`,
            PROXY_ID: 'missing-proxy',
            PROXY_POOLS_FILE_PATH: 'configs/does-not-exist-proxy-pools.json'
        }, providerType)).toThrow('Configured proxy node is unavailable: missing-proxy');
    });

    test('both Gemini request implementations use the strict account proxy helper', () => {
        const geminiSource = readFileSync('src/providers/gemini/gemini-core.js', 'utf8');
        const antigravitySource = readFileSync('src/providers/gemini/antigravity-core.js', 'utf8');

        expect(geminiSource).toContain('getRequiredProxyConfigForProvider');
        expect(antigravitySource).toContain('getRequiredProxyConfigForProvider');
    });
});
