import fs from 'fs';

describe('provider configuration mutation synchronization', () => {
    test('provider management mutations publish canonical provider types instead of assigning manager pools directly', () => {
        const source = fs.readFileSync('src/ui-modules/provider-api.js', 'utf8');
        expect(source).not.toContain('providerPoolManager.providerPools = providerPools');
        expect(source).toContain("providerPoolManager.publishProviderConfig(providerType, providerPools[providerType], { action: 'update'");
        expect(source).toContain("providerPoolManager.publishProviderConfig(providerType, providerPools[providerType], { action");
    });

    test('reload and reauthorization publish changed provider configuration', () => {
        const configSource = fs.readFileSync('src/ui-modules/config-api.js', 'utf8');
        const serviceSource = fs.readFileSync('src/services/service-manager.js', 'utf8');
        expect(configSource).toContain('publishChangedProviderConfigs(providerPoolManager, newConfig.providerPools');
        expect(serviceSource).toContain("providerPoolManager.publishProviderConfig(providerType, providerPools[providerType], { action: 'reauthorize'");
    });
});
