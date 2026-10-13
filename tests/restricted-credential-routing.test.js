import { describe, expect, test } from '@jest/globals';
import { routeKeyToCredentialCandidates, resolveKeyRoutingAssignment } from '../src/services/codex-key-routing.js';
import { getCodexRoutingConsistencyStatus } from '../src/services/codex-routing-integrity.js';

const credentials = [
    { uuid: 'codex-a', providerType: 'openai-codex-oauth', isHealthy: true, providerWeight: 3 },
    { uuid: 'codex-b', providerType: 'openai-codex-oauth', isHealthy: true, providerWeight: 1 },
    { uuid: 'codex-c', providerType: 'openai-codex-oauth', isHealthy: true, providerWeight: 1 }
];
const routing = { routingMode: 'restricted', restrictedCredentialUuids: ['codex-a', 'codex-c'] };

describe('restricted Codex credential pool', () => {
    test('keeps only the selected credentials', () => {
        const selected = routeKeyToCredentialCandidates({ keyRouting: routing, credentials });
        expect(selected).toMatchObject({
            routingMode: 'restricted',
            candidateProviderUuids: ['codex-a', 'codex-c'],
            errorCode: null
        });
    });

    test('uses the other selected credential when one is unavailable, never an outsider', () => {
        const selected = routeKeyToCredentialCandidates({
            keyRouting: routing,
            credentials: credentials.map(item => item.uuid === 'codex-a' ? { ...item, isHealthy: false } : item)
        });
        expect(selected.candidateProviderUuids).toEqual(['codex-c']);
        expect(selected.errorCode).toBeNull();
        const unavailable = routeKeyToCredentialCandidates({
            keyRouting: routing,
            credentials: credentials.map(item => item.uuid === 'codex-b' ? item : { ...item, isHealthy: false })
        });
        expect(unavailable.candidateProviderUuids).toEqual([]);
        expect(unavailable.errorCode).toBe('RESTRICTED_CREDENTIALS_UNAVAILABLE');
        const cooldown = routeKeyToCredentialCandidates({
            keyRouting: routing,
            credentials: credentials.map(item => item.uuid === 'codex-b' ? item : {
                ...item, isHealthy: false,
                scheduledRecoveryTime: new Date(Date.now() + 60_000).toISOString()
            })
        });
        expect(cooldown).toMatchObject({
            candidateProviderUuids: [], errorCode: 'PROVIDER_COOLDOWN',
            nextRecoveryTime: expect.any(String)
        });
    });

    test('a removed member cannot widen the set, and actual route membership is checked', () => {
        expect(routeKeyToCredentialCandidates({
            keyRouting: { ...routing, restrictedCredentialUuids: ['codex-a', 'missing'] },
            credentials
        })).toMatchObject({ candidateProviderUuids: ['codex-a'], errorCode: null });
        expect(routeKeyToCredentialCandidates({
            keyRouting: { ...routing, restrictedCredentialUuids: ['missing-a', 'missing-b'] },
            credentials
        }).errorCode).toBe('RESTRICTED_CREDENTIALS_UNAVAILABLE');
        expect(routeKeyToCredentialCandidates({
            keyRouting: routing,
            credentials: credentials.map(item => item.uuid === 'codex-c'
                ? { ...item, providerType: 'gemini-antigravity' } : item)
        }).errorCode).toBe('ROUTE_MISMATCH');
        expect(getCodexRoutingConsistencyStatus({
            routingMode: 'restricted',
            selectedProviderUuid: 'codex-c',
            restrictedCredentialUuids: routing.restrictedCredentialUuids,
            selectedGroupId: null,
            actualProviderGroupId: null
        }, 'codex-c')).toBe('consistent');
        expect(getCodexRoutingConsistencyStatus({
            routingMode: 'restricted',
            selectedProviderUuid: 'codex-b',
            restrictedCredentialUuids: routing.restrictedCredentialUuids,
            selectedGroupId: null,
            actualProviderGroupId: null
        }, 'codex-b')).toBe('mismatch');
    });

    test('resolves the restricted assignment from Key data and normalizes legacy auto to pool', () => {
        expect(resolveKeyRoutingAssignment({ id: 'key-1', ...routing })).toMatchObject(routing);
        expect(resolveKeyRoutingAssignment({ id: 'key-2', routingMode: 'auto', primaryGroupId: 'g' }))
            .toMatchObject({ routingMode: 'pool', fixedCredential: null, restrictedCredentialUuids: [] });
    });
});
