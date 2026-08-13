import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    CredentialGroupService,
    calculateCredentialCapacity,
    calculateTargetGroupCount,
    generateCredentialGroupSuggestion,
    routeKeyToCredentialCandidates,
    summarizeKeyDemand
} from '../src/services/codex-credential-group-service.js';

const tempDirs = [];
const NOW = new Date('2026-08-14T04:00:00.000Z');

function makeTempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-codex-groups-'));
    tempDirs.push(dir);
    return path.join(dir, 'codex-credential-groups.json');
}

function day(summary = {}) {
    return {
        summary: {
            requestCount: summary.requestCount || 0,
            totalTokens: summary.totalTokens || 0,
            cost: summary.cost || undefined
        }
    };
}

function createCredentials(count) {
    return Array.from({ length: count }, (_, index) => ({
        providerType: 'openai-codex-oauth',
        uuid: `cred-${index + 1}`,
        customName: `Credential ${index + 1}`,
        providerWeight: 1,
        fiveHourRemainingRatio: 1,
        weeklyRemainingRatio: 1,
        isHealthy: true
    }));
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('Codex credential group sizing and capacity', () => {
    test.each([
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 3],
        [6, 3],
        [9, 3],
        [10, 4]
    ])('uses %i healthy credentials to create %i groups', (credentials, groups) => {
        expect(calculateTargetGroupCount(credentials)).toBe(groups);
    });

    test('uses providerWeight times the lower of 5-hour and weekly remaining ratios', () => {
        expect(calculateCredentialCapacity({
            providerWeight: 2,
            fiveHourRemainingRatio: 0.8,
            weeklyRemainingRatio: 0.4
        })).toMatchObject({
            providerWeight: 2,
            quotaFactor: 0.4,
            capacity: 0.8,
            confidence: 'high'
        });
    });

    test('keeps weight-only credentials eligible and uses a conservative default with no capacity data', () => {
        expect(calculateCredentialCapacity({ providerWeight: 3 })).toMatchObject({
            capacity: 3,
            confidence: 'low'
        });
        expect(calculateCredentialCapacity({})).toMatchObject({
            capacity: 0.5,
            confidence: 'low'
        });
    });

    test('creates balanced 3/3/2/2 credential groups for ten healthy credentials', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(10),
            keys: [],
            now: NOW
        });

        expect(suggestion.applicable).toBe(true);
        expect(suggestion.groups.map(group => group.credentialUuids.length)).toEqual([3, 3, 2, 2]);
        expect(new Set(suggestion.groups.flatMap(group => group.credentialUuids)).size).toBe(10);
    });
});

describe('Codex key demand and capacity-aware assignment', () => {
    test('uses the latest seven complete Asia/Shanghai calendar days and excludes today', () => {
        const demand = summarizeKeyDemand({
            id: 'key-1',
            usageHistory: {
                '2026-08-06': day({ totalTokens: 9999, requestCount: 99 }),
                '2026-08-07': day({ totalTokens: 100, requestCount: 1 }),
                '2026-08-13': day({ totalTokens: 700, requestCount: 7 }),
                '2026-08-14': day({ totalTokens: 8888, requestCount: 88 })
            }
        }, { now: NOW, timeZone: 'Asia/Shanghai' });

        expect(demand.startDate).toBe('2026-08-07');
        expect(demand.endDate).toBe('2026-08-13');
        expect(demand.totalTokens).toBe(800);
        expect(demand.requestCount).toBe(8);
        expect(demand.metric).toBe('totalTokens');
    });

    test('falls back from actual cost to tokens and then request count', () => {
        const costDemand = summarizeKeyDemand({
            usageHistory: {
                '2026-08-13': day({
                    totalTokens: 1000,
                    requestCount: 10,
                    cost: { actualUsd: 2.5 }
                })
            }
        }, { now: NOW });
        const tokenDemand = summarizeKeyDemand({
            usageHistory: { '2026-08-13': day({ totalTokens: 1000, requestCount: 10 }) }
        }, { now: NOW });
        const requestDemand = summarizeKeyDemand({
            usageHistory: { '2026-08-13': day({ requestCount: 10 }) }
        }, { now: NOW });

        expect(costDemand).toMatchObject({ metric: 'actualUsd', totalDemand: 2.5 });
        expect(tokenDemand).toMatchObject({ metric: 'totalTokens', totalDemand: 1000 });
        expect(requestDemand).toMatchObject({ metric: 'requestCount', totalDemand: 10 });
    });

    test('capacity-balances new keys with no history', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(6),
            keys: Array.from({ length: 6 }, (_, index) => ({ id: `key-${index + 1}` })),
            now: NOW
        });
        const counts = suggestion.groups
            .map(group => suggestion.keyAssignments.filter(item => item.primaryGroupId === group.id).length)
            .sort((a, b) => b - a);

        expect(counts).toEqual([2, 2, 2]);
        expect(suggestion.keyAssignments.every(item => item.demand.isNew)).toBe(true);
    });

    test('marks clearly high-consumption keys in the preview', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                { id: 'key-hot', usageHistory: { '2026-08-13': day({ totalTokens: 1000 }) } },
                { id: 'key-a', usageHistory: { '2026-08-13': day({ totalTokens: 100 }) } },
                { id: 'key-b', usageHistory: { '2026-08-13': day({ totalTokens: 100 }) } }
            ],
            now: NOW
        });

        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-hot').highConsumption).toBe(true);
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-a').highConsumption).toBe(false);
    });

    test('does not move locked groups, credentials, or keys', () => {
        const credentials = createCredentials(4);
        credentials[1].manualLock = true;
        const currentConfig = {
            groups: [
                { id: 'group-a', manualLock: true, credentialUuids: ['cred-1'] },
                { id: 'group-b', credentialUuids: ['cred-2', 'cred-3'] },
                { id: 'group-c', credentialUuids: ['cred-4'] }
            ],
            keyAssignments: [
                { keyId: 'key-locked', routingMode: 'auto', primaryGroupId: 'group-c', manualLock: true }
            ]
        };

        const suggestion = generateCredentialGroupSuggestion({
            credentials,
            keys: [
                { id: 'key-locked', manualLock: true, primaryGroupId: 'group-c' },
                { id: 'key-free' }
            ],
            currentConfig,
            now: NOW
        });

        expect(suggestion.groups.find(group => group.id === 'group-a').credentialUuids).toEqual(['cred-1']);
        expect(suggestion.groups.find(group => group.id === 'group-b').credentialUuids).toContain('cred-2');
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-locked')).toMatchObject({
            primaryGroupId: 'group-c',
            manualLock: true
        });
    });
});

describe('Codex credential routing decisions', () => {
    const groups = [
        { id: 'group-1', credentialUuids: ['cred-1', 'cred-2'] },
        { id: 'group-2', credentialUuids: ['cred-3'] }
    ];

    test('fixed routing fails closed when the selected credential is unavailable', () => {
        const result = routeKeyToCredentialCandidates({
            keyRouting: {
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'cred-2' }
            },
            groups,
            credentials: [
                { uuid: 'cred-1', isHealthy: true },
                { uuid: 'cred-2', isHealthy: false },
                { uuid: 'cred-3', isHealthy: true }
            ]
        });

        expect(result).toMatchObject({
            errorCode: 'FIXED_CREDENTIAL_UNAVAILABLE',
            candidateProviderUuids: [],
            spillover: false
        });
    });

    test('auto routing spills over to another healthy group when the primary group is unavailable', () => {
        const result = routeKeyToCredentialCandidates({
            keyRouting: { routingMode: 'auto', primaryGroupId: 'group-1' },
            groups,
            credentials: [
                { uuid: 'cred-1', isHealthy: false },
                { uuid: 'cred-2', isHealthy: false },
                { uuid: 'cred-3', isHealthy: true }
            ]
        });

        expect(result).toMatchObject({
            selectedGroupId: 'group-2',
            candidateProviderUuids: ['cred-3'],
            spillover: true,
            spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE'
        });
    });
});

describe('Codex credential group revisions', () => {
    test('applies revisions and rolls back to the previous configuration', async () => {
        const filePath = makeTempFile();
        const service = new CredentialGroupService({ filePath, now: () => NOW });
        const first = await service.apply({
            applicable: true,
            groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-1' }]
        });
        const second = await service.apply({
            applicable: true,
            groups: [{ id: 'group-2', credentialUuids: ['cred-2'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-2' }]
        });
        const rolledBack = await service.rollback();

        expect(first.revision).toBe(1);
        expect(second.revision).toBe(2);
        expect(rolledBack).toMatchObject({ revision: 3, action: 'rollback', sourceRevision: 1 });
        expect((await service.getCurrentConfig()).groups[0].id).toBe('group-1');
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).currentRevision).toBe(3);
    });
});
