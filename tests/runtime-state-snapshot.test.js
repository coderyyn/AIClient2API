import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRuntimeStateSnapshot, diffRuntimeStateSnapshots } from '../scripts/runtime/runtime-state-snapshot.js';

describe('runtime state snapshot', () => {
    test('captures only hashes and stable provider fields', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-snapshot-'));
        await fs.mkdir(path.join(root, 'codex'));
        await fs.writeFile(path.join(root, 'codex', 'cred.json'), JSON.stringify({ access_token: 'secret' }));
        await fs.writeFile(path.join(root, 'provider_pools.json'), JSON.stringify({
            'openai-codex-oauth': [{
                uuid: 'account-a',
                isDisabled: false,
                concurrencyLimit: 0,
                providerWeight: 1,
                PROXY_ID: 'proxy-a',
                CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/cred.json',
                usageCount: 99,
                lastErrorMessage: 'secret-ish runtime detail'
            }]
        }));
        await fs.writeFile(path.join(root, 'model-usage-stats.json'), JSON.stringify({
            usageHistory: { '2026-08-12': { models: { 'gpt-5.4': { requestCount: 12 } } } }
        }));

        const snapshot = await createRuntimeStateSnapshot(root);

        expect(snapshot.providers[0]).toMatchObject({
            uuid: 'account-a',
            enabled: true,
            concurrencyLimit: 0,
            proxyId: 'proxy-a'
        });
        expect(snapshot.providers[0].credentialHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(snapshot)).not.toContain('secret');
        expect(JSON.stringify(snapshot)).not.toContain('usageCount');
        expect(snapshot.modelCounts['gpt-5.4']).toBe(12);
    });

    test('detects provider mutation and model-count deltas', () => {
        const before = {
            providerFingerprint: 'before',
            providers: [{ providerType: 'openai-codex-oauth', uuid: 'a', credentialHash: 'one' }],
            modelCounts: { 'gpt-5.4': 10 }
        };
        const after = {
            providerFingerprint: 'after',
            providers: [{ providerType: 'openai-codex-oauth', uuid: 'a', credentialHash: 'two' }],
            modelCounts: { 'gpt-5.4': 13, 'gpt-image-2': 2 }
        };

        expect(diffRuntimeStateSnapshots(before, after)).toEqual({
            providerFingerprintChanged: true,
            providerMutations: [{ providerType: 'openai-codex-oauth', uuid: 'a', fields: ['credentialHash'] }],
            modelCountDeltas: { 'gpt-5.4': 3, 'gpt-image-2': 2 }
        });
    });
});
