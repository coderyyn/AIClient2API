import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex provider weight UI source', () => {
    test('Codex OAuth provider edit/add base fields exclude providerWeight', () => {
        const source = readFileSync('static/app/modal.js', 'utf8');

        expect(source).toContain('function getProviderBaseFields(providerType)');
        expect(source).toContain("providerType === 'openai-codex-oauth'");
        expect(source).toContain("return baseFields.filter(field => field !== 'providerWeight')");
        expect(source).toContain('getProviderBaseFields(currentProviderType)');
        expect(source).toContain('getProviderBaseFields(providerType)');
        expect(source).toContain("hiddenProviderConfigFields.push('providerWeight')");
        expect(source).toContain("hiddenProviderConfigFields.push('weight')");
        expect(source).toContain("providerConfig.providerWeight = Number(document.getElementById('newProviderWeight')?.value || '1')");
    });
});
