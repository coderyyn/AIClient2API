import fs from 'fs';
import path from 'path';

function loadSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck ledger range stats surface', () => {
    test('admin API exposes ledger-backed range stats endpoint', () => {
        const source = loadSource('src/plugins/api-potluck/api-routes.js');

        expect(source).toContain("path === '/api/potluck/range-stats'");
        expect(source).toContain('async function loadLedgerRangeStatsForRange(range, conversionModel)');
        expect(source).toContain("readLedgerRangeStats({ ledgerDailyDir, dates, conversionModel })");
        expect(source).toContain("'permanent-usage-ledger', 'daily'");
        expect(source).toContain("source: 'ledger'");
    });

    test('ledger range stats module aggregates without exposing key material', () => {
        const source = loadSource('src/plugins/api-potluck/ledger-range-stats.js');

        expect(source).toContain('export function createLedgerRangeAggregator(');
        expect(source).toContain('export async function readLedgerRangeStats(');
        expect(source).toContain('export function resolveRangeDates(');
        expect(source).toContain('readline.createInterface');
        expect(source).not.toContain('row.key');
        expect(source).not.toContain('keyHash');
        expect(source).not.toContain('keyPrefix');
    });

    test('admin dashboard prefers ledger range stats without verbose data-source title', () => {
        const source = loadSource('static/potluck.html');

        expect(source).toContain('async function refreshLedgerRangeStats(range = currentUsageRange, { force = false } = {})');
        expect(source).toContain('function buildRangeSummaryFromLedger(ledgerStats, usageHistory = {}, range = currentUsageRange)');
        expect(source).not.toContain('function formatRangeDataSourceLabel(rangeSummary)');
        expect(source).not.toContain('数据源: 账本');
        expect(source).not.toContain('数据源: 实时统计');
        expect(source).toContain("apiRequest(`${API_BASE}/range-stats?range=${encodeURIComponent(range)}&${getCostQuery()}`)");
        expect(source).toContain("refreshLedgerRangeStats(currentUsageRange, { force: true });");
        expect(source).toContain('refreshLedgerRangeStats(currentUsageRange);');
    });
});
