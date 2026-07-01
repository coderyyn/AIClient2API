import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { UsageLedgerStore } from '../src/plugins/usage-ledger/ledger-store.js';

let tempDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-ledger-'));
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('usage ledger store', () => {
    test('records one fact per potluck key and request id using max token snapshot', async () => {
        const store = new UsageLedgerStore({ dir: tempDir, retentionDays: 35 });

        await store.recordFact({
            timestamp: '2026-07-01T02:00:00.000Z',
            requestId: 'req-1',
            potluckKeyHash: 'sha256:key-a',
            potluckKeyId: 'maki_a',
            provider: 'openai-codex-oauth',
            providerUuid: 'provider-a',
            accountEmail: 'user@example.com',
            requestedModel: 'gpt-5.3-codex-spark',
            actualModel: 'gpt-5.4-mini',
            promptTokens: 1000,
            cachedTokens: 400,
            completionTokens: 120,
            reasoningTokens: 80,
            totalTokens: 1120
        });
        await store.recordFact({
            timestamp: '2026-07-01T02:00:01.000Z',
            requestId: 'req-1',
            potluckKeyHash: 'sha256:key-a',
            potluckKeyId: 'maki_a',
            provider: 'openai-codex-oauth',
            providerUuid: 'provider-a',
            accountEmail: 'user@example.com',
            requestedModel: 'gpt-5.3-codex-spark',
            actualModel: 'gpt-5.4-mini',
            promptTokens: 1300,
            cachedTokens: 500,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450
        });

        const rows = await store.query({ since: '2026-07-01T00:00:00.000Z', until: '2026-07-02T00:00:00.000Z' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            requestId: 'req-1',
            potluckKeyHash: 'sha256:key-a',
            actualModel: 'gpt-5.4-mini',
            promptTokens: 1300,
            cachedTokens: 500,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450
        });
    });

    test('keeps the same request id separate across different potluck keys', async () => {
        const store = new UsageLedgerStore({ dir: tempDir, retentionDays: 35 });

        await store.recordFact({
            timestamp: '2026-07-01T02:00:00.000Z',
            requestId: 'req-shared',
            potluckKeyHash: 'sha256:key-a',
            totalTokens: 100
        });
        await store.recordFact({
            timestamp: '2026-07-01T02:00:00.000Z',
            requestId: 'req-shared',
            potluckKeyHash: 'sha256:key-b',
            totalTokens: 200
        });

        const rows = await store.query();
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.totalTokens).sort((a, b) => a - b)).toEqual([100, 200]);
    });

    test('records multiple facts in one batched day rewrite', async () => {
        const store = new UsageLedgerStore({ dir: tempDir, retentionDays: 35 });

        await store.recordFacts([
            {
                timestamp: '2026-07-01T02:00:00.000Z',
                requestId: 'req-batch-1',
                potluckKeyHash: 'sha256:key-a',
                totalTokens: 100
            },
            {
                timestamp: '2026-07-01T02:00:01.000Z',
                requestId: 'req-batch-1',
                potluckKeyHash: 'sha256:key-a',
                totalTokens: 150
            },
            {
                timestamp: '2026-07-01T02:00:02.000Z',
                requestId: 'req-batch-2',
                potluckKeyHash: 'sha256:key-a',
                totalTokens: 200
            }
        ]);

        const rows = await store.query();
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.totalTokens).sort((a, b) => a - b)).toEqual([150, 200]);
    });

    test('cleanup removes ledger files older than the retention window', async () => {
        const store = new UsageLedgerStore({ dir: tempDir, retentionDays: 2 });

        await store.recordFact({ timestamp: '2026-06-28T01:00:00.000Z', requestId: 'old', potluckKeyHash: 'sha256:key', totalTokens: 1 });
        await store.recordFact({ timestamp: '2026-07-01T01:00:00.000Z', requestId: 'keep', potluckKeyHash: 'sha256:key', totalTokens: 2 });

        await store.cleanup(new Date('2026-07-02T00:00:00.000Z'));

        expect(fs.existsSync(path.join(tempDir, 'usage-2026-06-28.jsonl'))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, 'usage-2026-07-01.jsonl'))).toBe(true);
    });
});
