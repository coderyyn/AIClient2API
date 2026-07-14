import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadStatsManager() {
    jest.resetModules();
    return await import('../src/plugins/model-usage-stats/stats-manager.js');
}

async function recordCodexUsage(statsManager, requestId, totalTokens) {
    statsManager.recordUnaryUsage({
        requestId,
        model: 'gpt-5.5',
        provider: 'openai-codex-oauth',
        providerUuid: 'codex-account-a',
        providerName: 'user@example.com',
        accountEmail: 'user@example.com',
        nativeResponse: {
            usage: {
                prompt_tokens: totalTokens,
                completion_tokens: 0,
                total_tokens: totalTokens
            }
        }
    });

    await statsManager.finalizeRequest({
        requestId,
        model: 'gpt-5.5',
        provider: 'openai-codex-oauth',
        providerUuid: 'codex-account-a',
        providerName: 'user@example.com',
        accountEmail: 'user@example.com',
        isStream: false
    });
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-model-usage-window-'));
    process.chdir(tempDir);
    jest.useFakeTimers();
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    jest.useRealTimers();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('model usage account token windows', () => {
    test('reports rolling 5h and current-week tokens for a Codex account', async () => {
        const statsManager = await loadStatsManager();

        jest.setSystemTime(new Date('2026-06-16T00:00:00.000Z'));
        await recordCodexUsage(statsManager, 'req-window-1', 100);

        jest.setSystemTime(new Date('2026-06-16T04:00:00.000Z'));
        await recordCodexUsage(statsManager, 'req-window-2', 250);

        let summary = await statsManager.getAccountTokenUsageSummary('openai-codex-oauth', 'codex-account-a', {
            accountEmail: 'user@example.com',
            now: new Date('2026-06-16T04:30:00.000Z')
        });
        expect(summary).toMatchObject({
            rolling5hTokens: 350,
            weeklyTokens: 350,
            totalTokens: 350
        });

        summary = await statsManager.getAccountTokenUsageSummary('openai-codex-oauth', 'codex-account-a', {
            accountEmail: 'user@example.com',
            now: new Date('2026-06-16T06:30:00.000Z')
        });
        expect(summary).toMatchObject({
            rolling5hTokens: 250,
            weeklyTokens: 350,
            totalTokens: 350
        });
    });

    test('reports the earliest rolling 5h recovery time below a token limit', async () => {
        const statsManager = await loadStatsManager();

        jest.setSystemTime(new Date('2026-06-16T00:00:00.000Z'));
        await recordCodexUsage(statsManager, 'req-recovery-1', 700);

        jest.setSystemTime(new Date('2026-06-16T03:00:00.000Z'));
        await recordCodexUsage(statsManager, 'req-recovery-2', 500);

        const summary = await statsManager.getAccountTokenUsageSummary('openai-codex-oauth', 'codex-account-a', {
            accountEmail: 'user@example.com',
            now: new Date('2026-06-16T04:00:00.000Z'),
            rolling5hTokenLimit: 1000
        });

        expect(summary).toMatchObject({
            rolling5hTokens: 1200,
            rolling5hRecoveryTime: '2026-06-16T05:00:00.001Z'
        });
    });
});
