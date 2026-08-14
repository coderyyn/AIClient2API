import fs from 'fs';

const helperPath = 'static/app/credential-group-view.js';

describe('credential-group focused management view', () => {
    test('ships a pure view helper module', () => {
        expect(fs.existsSync(helperPath)).toBe(true);
    });

    test('sorts active used keys by token, request count, and stable reference', async () => {
        const { sortCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const sorted = sortCredentialGroupKeys([
            { keyRef: 'key-c', enabled: true, demand: { totalTokens: 10, requestCount: 1 } },
            { keyRef: 'key-b', enabled: true, demand: { totalTokens: 20, requestCount: 1 } },
            { keyRef: 'key-a', enabled: true, demand: { totalTokens: 10, requestCount: 2 } },
            { keyRef: 'key-disabled', enabled: false, demand: { totalTokens: 999, requestCount: 9 } },
            { keyRef: 'key-new', enabled: true, demand: { totalTokens: 0, requestCount: 0, isNew: true } }
        ]);

        expect(sorted.map(key => key.keyRef)).toEqual([
            'key-b', 'key-a', 'key-c', 'key-new', 'key-disabled'
        ]);
    });

    test.each([
        ['one key exceeds the target', [90, 10], ['key-1']],
        ['one key exactly reaches the target', [80, 20], ['key-1']],
        ['multiple keys are needed to reach the target', [50, 20, 10, 10, 10], ['key-1', 'key-2', 'key-3']]
    ])('selects the smallest enabled key set covering 80%%: %s', async (_name, tokens, expected) => {
        const { getFocusedCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const keys = tokens.map((totalTokens, index) => ({
            keyRef: `key-${index + 1}`,
            enabled: true,
            routingMode: 'auto',
            manualLock: false,
            demand: { totalTokens, requestCount: totalTokens }
        }));

        expect(getFocusedCredentialGroupKeys(keys).visible.map(key => key.keyRef)).toEqual(expected);
    });

    test('always keeps fixed and manually locked keys while hiding disabled and zero-usage keys', async () => {
        const { getFocusedCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const result = getFocusedCredentialGroupKeys([
            { keyRef: 'heavy', enabled: true, routingMode: 'auto', demand: { totalTokens: 100, requestCount: 1 } },
            { keyRef: 'fixed', enabled: true, routingMode: 'fixed', demand: { totalTokens: 0, requestCount: 0 } },
            { keyRef: 'locked', enabled: true, routingMode: 'auto', manualLock: true, demand: { totalTokens: 0, requestCount: 0 } },
            { keyRef: 'new', enabled: true, routingMode: 'auto', demand: { totalTokens: 0, requestCount: 0, isNew: true } },
            { keyRef: 'disabled', enabled: false, routingMode: 'fixed', demand: { totalTokens: 500, requestCount: 5 } }
        ]);

        expect(result.visible.map(key => key.keyRef)).toEqual(['heavy', 'fixed', 'locked']);
        expect(result.hiddenCount).toBe(2);
    });

    test('shows only healthy routeable credentials with positive capacity by default', async () => {
        const { getFocusedCredentials } = await import('../static/app/credential-group-view.js');
        const result = getFocusedCredentials([
            { credentialRef: 'healthy', available: true, isHealthy: true, isDisabled: false, needsRefresh: false, capacity: 0.6 },
            { credentialRef: 'empty', available: false, isHealthy: false, isDisabled: false, needsRefresh: false, capacity: 0 },
            { credentialRef: 'disabled', available: true, isHealthy: true, isDisabled: true, needsRefresh: false, capacity: 1 },
            { credentialRef: 'stale', available: true, isHealthy: true, isDisabled: false, needsRefresh: true, capacity: 1 }
        ]);

        expect(result.visible.map(item => item.credentialRef)).toEqual(['healthy']);
        expect(result.hiddenCount).toBe(3);
    });
});
