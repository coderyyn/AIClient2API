import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex provider weight UI source', () => {
    test('Codex OAuth provider edit/add base fields keep providerWeight and hide legacy weight', () => {
        const source = readFileSync('static/app/modal.js', 'utf8');

        expect(source).toContain('function getProviderBaseFields(providerType)');
        expect(source).toContain('getProviderBaseFields(currentProviderType)');
        expect(source).toContain('getProviderBaseFields(providerType)');
        expect(source).toContain("'providerWeight'");
        expect(source).toContain("'weight'");
        expect(source).not.toContain("return baseFields.filter(field => field !== 'providerWeight')");
        expect(source).not.toContain("hiddenProviderConfigFields.push('providerWeight')");
        expect(source).toContain("providerConfig.providerWeight = Number(document.getElementById('newProviderWeight')?.value || '1')");
    });
});
