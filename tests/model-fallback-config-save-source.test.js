import { readFileSync } from 'fs';

describe('model fallback config persistence source contract', () => {
    test('saves MODEL_FALLBACK_ENABLED into config.json payload', () => {
        const source = readFileSync('src/ui-modules/config-api.js', 'utf8');
        const saveBlockStart = source.indexOf('const configToSave = {');
        const saveBlockEnd = source.indexOf('await atomicWriteFile(configPath', saveBlockStart);
        const saveBlock = source.slice(saveBlockStart, saveBlockEnd);

        expect(saveBlockStart).toBeGreaterThan(-1);
        expect(saveBlockEnd).toBeGreaterThan(saveBlockStart);
        expect(saveBlock).toContain('MODEL_FALLBACK_ENABLED: currentConfig.MODEL_FALLBACK_ENABLED');
    });
});
