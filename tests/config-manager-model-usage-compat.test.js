import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeConfig } from '../src/core/config-manager.js';

const tempDirs = [];

function writeConfig(overrides) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-config-'));
    tempDirs.push(tempDir);

    const promptPath = path.join(tempDir, 'system-prompt.txt');
    const providerPoolsPath = path.join(tempDir, 'provider-pools.json');
    const customModelsPath = path.join(tempDir, 'custom-models.json');
    const configPath = path.join(tempDir, 'config.json');

    fs.writeFileSync(promptPath, '', 'utf8');
    fs.writeFileSync(providerPoolsPath, '{}', 'utf8');
    fs.writeFileSync(customModelsPath, '[]', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify({
        LOG_ENABLED: false,
        SYSTEM_PROMPT_FILE_PATH: promptPath,
        PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
        CUSTOM_MODELS_FILE_PATH: customModelsPath,
        ...overrides
    }), 'utf8');

    return configPath;
}

afterEach(() => {
    tempDirs.splice(0).forEach((tempDir) => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});

describe('model usage persistence configuration compatibility', () => {
    test('uses the legacy persistence interval when the debounce setting is absent', async () => {
        const configPath = writeConfig({
            MODEL_USAGE_STATS_PERSIST_INTERVAL: 5_000
        });

        const config = await initializeConfig([], configPath);

        expect(config.MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS).toBe(5_000);
    });

    test('uses the debounce setting when only the new setting is provided', async () => {
        const configPath = writeConfig({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 7_000
        });

        const config = await initializeConfig([], configPath);

        expect(config.MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS).toBe(7_000);
    });

    test('prefers the debounce setting when both new and legacy settings are provided', async () => {
        const configPath = writeConfig({
            MODEL_USAGE_STATS_PERSIST_INTERVAL: 5_000,
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 7_000
        });

        const config = await initializeConfig([], configPath);

        expect(config.MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS).toBe(7_000);
    });
});
