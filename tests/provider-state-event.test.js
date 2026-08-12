import { createProviderStateEvent, applyProviderStateEvent } from '../src/runtime/provider-state-event.js';

describe('provider state persistence events', () => {
    test('contains mutable scheduling state but excludes credentials and proxy data', () => {
        const event = createProviderStateEvent('provider', {
            uuid: 'one',
            accessToken: 'secret',
            refreshToken: 'refresh-secret',
            proxy: 'socks5://secret',
            isHealthy: false,
            errorCount: 2,
            lastErrorMessage: 'limited',
            scheduledRecoveryTime: '2026-08-12T10:00:00.000Z'
        });
        expect(event).toMatchObject({ providerType: 'provider', uuid: 'one', state: { isHealthy: false, errorCount: 2 } });
        expect(JSON.stringify(event)).not.toMatch(/accessToken|refreshToken|proxy|secret/);
    });

    test('applies only whitelisted state to the canonical provider', () => {
        const target = { uuid: 'one', accessToken: 'keep', isHealthy: true };
        const applied = applyProviderStateEvent({ provider: [target] }, {
            providerType: 'provider',
            uuid: 'one',
            state: { isHealthy: false, accessToken: 'replace' }
        });
        expect(applied).toBe(true);
        expect(target.isHealthy).toBe(false);
        expect(target.accessToken).toBe('keep');
    });
});
