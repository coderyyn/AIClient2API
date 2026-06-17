import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('proxy config save invalidates cached adapters', () => {
    test('clears service adapter cache when proxy runtime config changes', () => {
        const source = readFileSync('src/ui-modules/config-api.js', 'utf8');

        expect(source).toContain('const PROXY_RUNTIME_CONFIG_KEYS = [');
        expect(source).toContain('function invalidateServiceInstancesForProxyChange()');
        expect(source).toContain('if (hasProxyRuntimeConfigChanged(previousProxyRuntimeConfig, currentConfig))');
        expect(source).toContain('invalidateServiceInstancesForProxyChange();');
    });
});
