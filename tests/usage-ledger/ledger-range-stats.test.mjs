import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLedgerRangeAggregator,
  getBeijingDateKey,
  listLedgerDates,
  readLedgerRangeStats,
  resolveRangeDates,
} from '../../src/plugins/api-potluck/ledger-range-stats.js';

function row({ date = '2026-07-05', provider = 'openai-codex-oauth', accountKey, accountEmail = 'user@example.com', model = 'gpt-5.5', requestCount = 1, totalTokens = 100, promptTokens = 80, completionTokens = 20, cachedTokens = 10, actualUsd = 0.01, missingPriceTokens = 0 }) {
  return {
    date,
    provider,
    accountKey: accountKey || `${provider}:${accountEmail}`,
    accountEmail,
    accountIdentity: accountEmail,
    providerName: 'User',
    providerUuids: ['uuid-1'],
    key: 'maki_secret_should_not_leak',
    keyHash: 'sha256:deadbeef',
    keyPrefix: 'maki_secret...',
    model,
    usage: { requestCount, promptTokens, cachedTokens, completionTokens, reasoningTokens: 0, totalTokens },
    cost: { actualUsd, missingPriceTokens, pricingModel: model },
  };
}

test('aggregator groups rows by provider, model, and account with cost totals', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  aggregator.addRow(row({ model: 'gpt-5.5', totalTokens: 100, requestCount: 2, actualUsd: 0.02 }));
  aggregator.addRow(row({ model: 'gpt-5.4-mini', totalTokens: 50, requestCount: 1, actualUsd: 0.01 }));
  aggregator.addRow(row({ accountEmail: 'other@example.com', model: 'gpt-5.5', totalTokens: 30, requestCount: 1, actualUsd: 0.003 }));

  const result = aggregator.result();

  assert.equal(result.summary.requestCount, 4);
  assert.equal(result.summary.totalTokens, 180);
  assert.ok(Math.abs(result.summary.cost.actualUsd - 0.00205325) < 1e-12);
  assert.ok(result.summary.cost.convertedUsd > 0);
  assert.equal(result.summary.cost.conversionModel, 'gemini-2.5-flash');

  assert.deepEqual(Object.keys(result.providers), ['openai-codex-oauth']);
  assert.equal(result.providers['openai-codex-oauth'].totalTokens, 180);

  assert.deepEqual(Object.keys(result.models).sort(), ['gpt-5.4-mini', 'gpt-5.5']);
  assert.equal(result.models['gpt-5.5'].totalTokens, 130);

  const accountNames = Object.keys(result.accounts).sort();
  assert.deepEqual(accountNames, [
    'openai-codex-oauth:other@example.com',
    'openai-codex-oauth:user@example.com',
  ]);
  assert.equal(result.accounts['openai-codex-oauth:user@example.com'].summary.totalTokens, 150);
  assert.equal(result.accounts['openai-codex-oauth:user@example.com'].models['gpt-5.5'].totalTokens, 100);
});

test('aggregator reprices stale GPT-5.6 ledger rows with current prices', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  const usage = {
    promptTokens: 1_000_000,
    cachedTokens: 250_000,
    completionTokens: 100_000,
    totalTokens: 1_100_000,
  };
  aggregator.addRow(row({
    model: 'gpt-5.6-sol',
    ...usage,
    actualUsd: 0,
    missingPriceTokens: usage.totalTokens,
  }));
  aggregator.addRow(row({
    model: 'gpt-5.6-sol-fast',
    ...usage,
    actualUsd: 0,
    missingPriceTokens: usage.totalTokens,
  }));

  const result = aggregator.result();
  const normalCost = ((750_000 * 5) + (250_000 * 0.5) + (100_000 * 30)) / 1_000_000;

  assert.equal(result.models['gpt-5.6-sol'].cost.missingPriceTokens, 0);
  assert.equal(result.models['gpt-5.6-sol-fast'].cost.missingPriceTokens, 0);
  assert.ok(Math.abs(result.models['gpt-5.6-sol'].cost.actualUsd - normalCost) < 1e-12);
  assert.ok(Math.abs(result.models['gpt-5.6-sol-fast'].cost.actualUsd - normalCost * 2.5) < 1e-12);
});

test('aggregated output never contains key material', () => {
  const aggregator = createLedgerRangeAggregator({});
  aggregator.addRow(row({}));
  const serialized = JSON.stringify(aggregator.result());
  assert.equal(serialized.includes('maki_secret'), false);
  assert.equal(serialized.includes('keyHash'), false);
  assert.equal(serialized.includes('deadbeef'), false);
});

test('readLedgerRangeStats reads existing files and reports missing dates', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    const dailyDir = path.join(tmpDir, 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      path.join(dailyDir, 'usage-2026-07-04.jsonl'),
      JSON.stringify(row({ date: '2026-07-04', totalTokens: 100, requestCount: 1 })) + '\n'
    );

    const result = await readLedgerRangeStats({
      ledgerDailyDir: dailyDir,
      dates: ['2026-07-04', '2026-07-05'],
      conversionModel: 'gemini-2.5-flash',
    });

    assert.deepEqual(result.availableDates, ['2026-07-04']);
    assert.deepEqual(result.missingDates, ['2026-07-05']);
    assert.equal(result.summary.totalTokens, 100);
    assert.equal(listLedgerDates(dailyDir).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readLedgerRangeStats skips today ledger file so UI can use live stats', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    const dailyDir = path.join(tmpDir, 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const now = new Date('2026-07-05T20:00:00.000Z'); // 北京时间 2026-07-06
    fs.writeFileSync(
      path.join(dailyDir, 'usage-2026-07-06.jsonl'),
      JSON.stringify(row({ date: '2026-07-06', totalTokens: 50, requestCount: 1 })) + '\n'
    );

    const result = await readLedgerRangeStats({
      ledgerDailyDir: dailyDir,
      dates: ['2026-07-06'],
      now,
    });

    assert.deepEqual(result.availableDates, []);
    assert.deepEqual(result.missingDates, ['2026-07-06']);
    assert.equal(result.summary.totalTokens, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRangeDates maps ranges to beijing date lists', () => {
  const now = new Date('2026-07-05T20:00:00.000Z'); // 2026-07-06 04:00 北京时间
  assert.equal(getBeijingDateKey(now), '2026-07-06');
  assert.deepEqual(resolveRangeDates('today', { now }), ['2026-07-06']);

  const week = resolveRangeDates('7d', { now });
  assert.equal(week.length, 7);
  assert.equal(week[0], '2026-06-30');
  assert.equal(week[6], '2026-07-06');

  const month = resolveRangeDates('30d', { now });
  assert.equal(month.length, 30);
  assert.equal(month[0], '2026-06-07');
});

test('resolveRangeDates total uses ledger directory contents plus today', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'usage-2026-05-01.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'usage-2026-05-02.jsonl'), '');
    const now = new Date('2026-07-05T20:00:00.000Z');
    const dates = resolveRangeDates('total', { ledgerDailyDir: tmpDir, now });
    assert.deepEqual(dates, ['2026-05-01', '2026-05-02', '2026-07-06']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
