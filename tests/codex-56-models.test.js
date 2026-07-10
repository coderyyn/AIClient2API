import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getProviderModels
} from '../src/providers/provider-models.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('codex 5.6 model registration', () => {
    test('lists GPT-5.6 Codex models while retaining Codex Spark preview', () => {
        const models = getProviderModels('openai-codex-oauth');

        expect(models).toEqual(expect.arrayContaining([
            'gpt-5.3-codex-spark',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini'
        ]));
    });

    test('keeps bare GPT-5.6 invalid and falls unknown models back to GPT-5.4 mini', () => {
        const routingSource = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'service-manager.js'), 'utf8');
        const codexSource = fs.readFileSync(path.join(repoRoot, 'src', 'providers', 'openai', 'codex-core.js'), 'utf8');

        expect(routingSource).not.toContain("'openai-codex-oauth:gpt-5.6': 'gpt-5.6-sol'");
        expect(routingSource).toContain("const DEFAULT_CODEX_FALLBACK_MODEL = 'gpt-5.4-mini';");
        expect(routingSource).toContain('actualModelName = DEFAULT_CODEX_FALLBACK_MODEL;');
        expect(codexSource).toContain("const DEFAULT_CODEX_FALLBACK_MODEL = 'gpt-5.4-mini';");
        expect(codexSource.match(/selectedModel = DEFAULT_CODEX_FALLBACK_MODEL;/g)).toHaveLength(2);
    });
});
