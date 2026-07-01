import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { rebuildUsageLedger } from '../src/plugins/usage-ledger/rebuild.js';

let tempDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-ledger-rebuild-'));
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('usage ledger rebuild', () => {
    test('rebuilds exact facts from request audit without prompt payloads', async () => {
        const auditDir = path.join(tempDir, 'request-audit');
        const ledgerDir = path.join(tempDir, 'usage-ledger');
        fs.mkdirSync(auditDir, { recursive: true });
        fs.writeFileSync(path.join(auditDir, 'audit-2026-07-01.jsonl'), `${JSON.stringify({
            timestamp: '2026-07-01T02:00:00.000Z',
            beijingDate: '2026-07-01',
            requestId: 'req-audit-1',
            request: {
                toProvider: 'openai-codex-oauth',
                requestedModel: 'gpt-5.3-codex-spark',
                actualModel: 'gpt-5.4-mini',
                model: 'gpt-5.4-mini',
                stream: true
            },
            potluckKey: {
                hash: 'sha256:key-a',
                name: 'Client A'
            },
            account: {
                providerUuid: 'provider-a',
                providerNameDisplay: 'redacted-email:abcd1234'
            },
            usage: {
                promptTokens: 1000,
                cachedTokens: 400,
                completionTokens: 120,
                reasoningTokens: 80,
                totalTokens: 1120
            },
            originalRequestBody: { messages: [{ content: 'do not copy me' }] }
        })}\n`);

        const result = await rebuildUsageLedger({ auditDir, ledgerDir });
        const rows = fs.readFileSync(path.join(ledgerDir, 'usage-2026-07-01.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        expect(result.auditFacts).toBe(1);
        const summary = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'usage-summary.json'), 'utf8'));
        expect(summary.usageHistory['2026-07-01'].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1120
        });
        expect(summary.byKeyHash['sha256:key-a'].usageHistory['2026-07-01'].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1120
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            requestId: 'req-audit-1',
            potluckKeyHash: 'sha256:key-a',
            provider: 'openai-codex-oauth',
            providerUuid: 'provider-a',
            accountDisplay: 'redacted-email:abcd1234',
            requestedModel: 'gpt-5.3-codex-spark',
            actualModel: 'gpt-5.4-mini',
            totalTokens: 1120,
            source: 'request-audit'
        });
        expect(JSON.stringify(rows[0])).not.toContain('do not copy me');
    });

    test('backfills account and model facts from model usage stats for dates without audit coverage', async () => {
        const auditDir = path.join(tempDir, 'request-audit');
        const ledgerDir = path.join(tempDir, 'usage-ledger');
        const modelUsagePath = path.join(tempDir, 'model-usage-stats.json');
        fs.mkdirSync(auditDir, { recursive: true });
        fs.writeFileSync(path.join(auditDir, 'audit-2026-07-01.jsonl'), '');
        fs.writeFileSync(modelUsagePath, JSON.stringify({
            daily: {
                '2026-06-30': {
                    accounts: {
                        'openai-codex-oauth:user@example.com': {
                            summary: { requestCount: 2, totalTokens: 2300 },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 2,
                                    promptTokens: 2000,
                                    cachedTokens: 500,
                                    completionTokens: 300,
                                    reasoningTokens: 80,
                                    totalTokens: 2300
                                }
                            }
                        }
                    }
                },
                '2026-07-01': {
                    accounts: {
                        'openai-codex-oauth:user@example.com': {
                            summary: { requestCount: 1, totalTokens: 1100 },
                            models: { 'gpt-5.4-mini': { requestCount: 1, totalTokens: 1100 } }
                        }
                    }
                }
            }
        }));

        const result = await rebuildUsageLedger({ auditDir, ledgerDir, modelUsagePath });
        const rows = fs.readFileSync(path.join(ledgerDir, 'usage-2026-06-30.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        expect(result.modelUsageFallbackFacts).toBe(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            requestId: 'model-usage-stats:2026-06-30:openai-codex-oauth:user@example.com:gpt-5.4-mini',
            potluckKeyHash: null,
            provider: 'openai-codex-oauth',
            accountEmail: 'user@example.com',
            actualModel: 'gpt-5.4-mini',
            totalTokens: 2300,
            source: 'model-usage-stats'
        });
    });

    test('skips failed audit events and zero token audit events', async () => {
        const auditDir = path.join(tempDir, 'request-audit');
        const ledgerDir = path.join(tempDir, 'usage-ledger');
        fs.mkdirSync(auditDir, { recursive: true });
        fs.writeFileSync(path.join(auditDir, 'audit-2026-07-01.jsonl'), [
            {
                timestamp: '2026-07-01T02:00:00.000Z',
                requestId: 'req-failed',
                request: { toProvider: 'openai-codex-oauth', model: 'gtp-5.1' },
                status: { outcome: 'error', httpStatus: 500 },
                usage: { totalTokens: 900 }
            },
            {
                timestamp: '2026-07-01T02:01:00.000Z',
                requestId: 'req-zero',
                request: { toProvider: 'openai-codex-oauth', model: 'gpt-5.4-mini' },
                status: { outcome: 'success', httpStatus: 200 },
                usage: { totalTokens: 0 }
            }
        ].map(row => JSON.stringify(row)).join('\n') + '\n');

        const result = await rebuildUsageLedger({ auditDir, ledgerDir });

        expect(result.auditFacts).toBe(0);
        expect(fs.existsSync(path.join(ledgerDir, 'usage-2026-07-01.jsonl'))).toBe(false);
    });
});
