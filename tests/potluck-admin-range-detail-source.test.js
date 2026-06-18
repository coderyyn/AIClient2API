import fs from 'fs';
import path from 'path';

function loadPotluckSource() {
    return fs.readFileSync(path.join(process.cwd(), 'static', 'potluck.html'), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck admin range and key detail UI source', () => {
    test('admin dashboard exposes a cumulative-default usage range switcher', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="usageRangeToggle"');
        expect(source).toContain("let currentUsageRange = 'total'");
        expect(source).toContain("data-range=\"total\"");
        expect(source).toContain("data-range=\"7d\"");
        expect(source).toContain("data-range=\"today\"");
        expect(source).toContain('function setUsageRange(range)');
        expect(source).toContain('function getUsageRangeDates(range, usageHistory = {})');
        expect(source).toContain('function summarizeUsageHistoryForRange(usageHistory = {}, range = currentUsageRange)');
    });

    test('each admin key card has a detail modal entry for user-facing usage diagnostics', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="keyDetailModal"');
        expect(source).toContain('function showKeyDetail(keyId)');
        expect(source).toContain('function renderKeyDetailModal(key)');
        expect(source).toContain('function closeKeyDetailModal()');
        expect(source).toContain("onclick=\"showKeyDetail('${key.id}')\"");
        expect(source).toContain('用户端视图');
        expect(source).toContain('范围内服务商');
        expect(source).toContain('范围内模型');
    });

    test('admin dashboard uses lightweight first paint and lazy key details', () => {
        const source = loadPotluckSource();

        expect(source).not.toContain('cdnjs.cloudflare.com/ajax/libs/font-awesome');
        expect(source).toContain('const KEYS_PAGE_SIZE = 20');
        expect(source).toContain('id="keysPagination"');
        expect(source).toContain('function renderCurrentKeysPage()');
        expect(source).toContain('window.requestAnimationFrame');
        expect(source).toContain('key.rangeSummaries?.[currentUsageRange]');
        expect(source).toContain('key.recentUsageHistory || key.usageHistory');
        expect(source).toContain("apiRequest(`${API_BASE}/keys/${encodeURIComponent(keyId)}`)");
    });
});
