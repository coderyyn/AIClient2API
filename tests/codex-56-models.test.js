import { describe, expect, test } from '@jest/globals';

import {
    getProviderModels
} from '../src/providers/provider-models.js';

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
});
