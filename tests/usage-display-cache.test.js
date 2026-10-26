import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;

async function loadUsageCacheModule() {
    jest.resetModules();
    return import('../src/ui-modules/usage-cache.js');
}

function createProductionScaleUsage() {
    const makeInstances = (prefix, count, rawSize) => Array.from({ length: count }, (_, index) => ({
        uuid: `${prefix}-${index + 1}`,
        name: `${prefix}-${index + 1}`,
        success: true,
        isHealthy: index % 5 !== 0,
        isDisabled: false,
        usage: {
            raw: { payload: 'x'.repeat(rawSize), account: `${prefix}-${index + 1}` },
            summary: {
                plan: prefix === 'antigravity' ? 'Ultra' : 'Plus',
                usedPercent: index * 3,
                resetAt: '2026-08-12T00:00:00.000Z'
            },
            items: [{ name: 'quota', usedPercent: index * 3 }]
        }
    }));

    return {
        timestamp: '2026-08-11T12:00:00.000Z',
        providers: {
            'gemini-antigravity': {
                providerType: 'gemini-antigravity',
                instances: makeInstances('antigravity', 12, 100_000)
            },
            'openai-codex-oauth': {
                providerType: 'openai-codex-oauth',
                instances: makeInstances('codex', 13, 20_000)
            }
        }
    };
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-usage-display-'));
    process.chdir(tempDir);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('usage display cache', () => {
    test('counts fresh refreshes separately from stale cards and skipped providers', async () => {
        const { buildUsageDisplaySnapshot } = await loadUsageCacheModule();
        const snapshot = buildUsageDisplaySnapshot({ providers: {
            'gemini-antigravity': { successCount: 5, instances: [
                { uuid: 'fresh-a', success: true },
                { uuid: 'fresh-b', success: true },
                { uuid: 'stale', success: true, staleUsage: true },
                { uuid: 'disabled', success: true, isDisabled: true },
                { uuid: 'archived', success: true, isArchived: true }
            ] }
        } });
        expect(snapshot.providers['gemini-antigravity']).toMatchObject({
            successCount: 2, errorCount: 1, staleCount: 1, refreshableCount: 3,
            totalCount: 4, archivedCount: 1, skippedCount: 2
        });
    });

    test('keeps raw data in canonical cache but removes it from the browser snapshot', async () => {
        const usageData = createProductionScaleUsage();
        const { writeUsageCache, readUsageCache, readUsageDisplayCache } = await loadUsageCacheModule();

        await writeUsageCache(usageData);

        const rawCache = await readUsageCache({ maxAgeMs: null });
        const displayCache = await readUsageDisplayCache({ maxAgeMs: null });
        expect(rawCache.providers['gemini-antigravity'].instances[0].usage.raw).toBeDefined();
        expect(displayCache.providers['gemini-antigravity'].instances[0].usage.raw).toBeUndefined();
        expect(displayCache.providers['gemini-antigravity'].instances[0].usage).toMatchObject({
            summary: { plan: 'Ultra', usedPercent: 0 },
            items: [{ name: 'quota', usedPercent: 0 }]
        });
    });

    test('production-scale browser snapshot stays below 300 KB', async () => {
        const { buildUsageDisplaySnapshot } = await loadUsageCacheModule();
        const displayData = buildUsageDisplaySnapshot(createProductionScaleUsage());

        expect(Buffer.byteLength(JSON.stringify(displayData), 'utf8')).toBeLessThan(300 * 1024);
    });
});
