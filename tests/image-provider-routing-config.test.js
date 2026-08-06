import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';

describe('image provider round-robin configuration', () => {
    test('defaults to enabled and exposes a CLI flag', () => {
        const source = readFileSync('src/core/config-manager.js', 'utf8');

        expect(source).toContain('IMAGE_PROVIDER_ROUND_ROBIN_ENABLED: true');
        expect(source).toContain("--image-provider-round-robin-enabled");
    });

    test('round-trip exposes the setting through the config API and admin UI', () => {
        const configApi = readFileSync('src/ui-modules/config-api.js', 'utf8');
        const html = readFileSync('static/components/section-config.html', 'utf8');
        const manager = readFileSync('static/app/config-manager.js', 'utf8');

        expect(configApi).toContain('IMAGE_PROVIDER_ROUND_ROBIN_ENABLED');
        expect(html).toContain('imageProviderRoundRobinEnabled');
        expect(manager).toContain('IMAGE_PROVIDER_ROUND_ROBIN_ENABLED');
    });
});
