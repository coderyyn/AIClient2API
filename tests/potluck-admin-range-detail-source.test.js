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

    test('admin provider distribution shows token share from the center provider view', () => {
        const source = loadPotluckSource();

        expect(source).toContain('function renderProviderAccountTokenTree(elementId, providers, accounts, totalTokens)');
        expect(source).toContain("renderProviderAccountTokenTree('providerAccountDistribution', rangeSummary.providers, rangeSummary.accounts, totalTokens)");
        expect(source).toContain('usageTokens(b) - usageTokens(a)');
        expect(source).toContain('formatTokenCompact(tokens)');
        expect(source).toContain('Token');
        expect(source).toContain('次');
    });

    test('admin dashboard folds account token share into the provider tree view', () => {
        const source = loadPotluckSource();

        expect(source).toContain('Provider / 账号 Token 占比');
        expect(source).toContain('id="providerAccountDistribution"');
        expect(source).toContain('id="providerAccountTotalCount"');
        expect(source).not.toContain('id="codexAccountDistribution"');
        expect(source).not.toContain('id="codexAccountTotalCount"');
        expect(source).toContain('function buildProviderAccountTokenTree(providers, accounts)');
        expect(source).toContain('function renderProviderAccountRows(provider)');
        expect(source).toContain('provider-account-children');
        expect(source).toContain('account-sub');
        expect(source).toContain('isCodexOauthAccount(account)');
        expect(source).toContain('Object.entries(day.accounts || {})');
    });

    test('admin provider account tree preserves Codex account identity metadata', () => {
        const source = loadPotluckSource();

        expect(source).toContain('accountIdentity: account.accountIdentity ||');
        expect(source).toContain('providerUuids: Array.isArray(account.providerUuids)');
        expect(source).toContain('account?.providerName || account?.accountIdentity');
        expect(source).toContain('const providerCount = Array.isArray(account.providerUuids) ? account.providerUuids.length : 0');
        expect(source).toContain('providers`');
    });
});
