import { readFileSync } from 'fs';

describe('Codex reauthorization UI wiring', () => {
    test('provider modal exposes an in-place reauthorization action', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const providerManagerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(modalSource).toContain('reauthorizeProvider');
        expect(modalSource).toContain('targetProviderUuid');
        expect(modalSource).toContain('modal.provider.reauthorize');
        expect(providerManagerSource).toContain('targetProviderUuid');
    });
});
