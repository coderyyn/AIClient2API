import fs from 'fs';
import path from 'path';

describe('api potluck keys list compact source', () => {
    test('admin keys list strips heavy per-day details while keeping summaries', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function compactKeyForList(key)');
        expect(source).toContain('function compactUsageHistoryForList(usageHistory = {})');
        expect(source).toContain('summary: day?.summary || {}');
        expect(source).toContain('listKeys({ ...costOptions, summaryOnly: true })');
        expect(source).toContain('keys.map(compactKeyForList)');
        expect(source).toContain('delete compact.usageHistory[date].providers');
        expect(source).toContain('delete compact.usageHistory[date].models');
        expect(source).toContain('delete compact.usageHistory[date].accounts');
        expect(source).toContain('delete compact.usageHistory[date].hours');
    });
});
