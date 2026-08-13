import { applyProviderConfigEvent, createProviderConfigEvent } from '../src/runtime/provider-config-event.js';

describe('provider config runtime synchronization', () => {
    test('replaces the complete provider type and reports changed UUIDs', () => {
        const pools = {
            'openai-codex-oauth': [{
                uuid: 'node-1',
                checkModelName: 'gpt-5.4',
                PROXY_ID: 'old-proxy',
                CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/old.json',
                isDisabled: true
            }]
        };
        const event = createProviderConfigEvent('openai-codex-oauth', [{
            uuid: 'node-1',
            checkModelName: 'gpt-5.4-mini',
            PROXY_ID: 'new-proxy',
            CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/new.json',
            isDisabled: false
        }], { revision: 7, action: 'update' });

        const result = applyProviderConfigEvent(pools, event, { revision: 2 });

        expect(result).toMatchObject({ applied: true, revision: 7, changedUuids: ['node-1'] });
        expect(pools['openai-codex-oauth'][0]).toMatchObject({
            checkModelName: 'gpt-5.4-mini',
            PROXY_ID: 'new-proxy',
            CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/new.json',
            isDisabled: false
        });
    });

    test('rejects stale or malformed synchronization events without mutation', () => {
        const pools = { test: [{ uuid: 'one', value: 'current' }] };
        expect(applyProviderConfigEvent(pools, { type: 'provider_config_sync', revision: 2, providerType: 'test', providers: [] }, { revision: 3 }).applied).toBe(false);
        expect(applyProviderConfigEvent(pools, { type: 'provider_config_sync', revision: 4, providerType: 'test', providers: 'bad' }, { revision: 3 }).applied).toBe(false);
        expect(pools.test[0].value).toBe('current');
    });
});
