import fs from 'fs';
import path from 'path';

function loadPotluckSource() {
    return fs.readFileSync(path.join(process.cwd(), 'static', 'potluck.html'), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck admin range and key detail UI source', () => {
    test('admin dashboard exposes a cumulative-default usage range switcher', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="usageRangeToggle"');
        expect(source).toContain("let currentUsageRange = '7d'");
        expect(source).toContain('<button class="range-option" data-range="total" onclick="setUsageRange(\'total\')" aria-pressed="false">累计</button>');
        expect(source).toContain("data-range=\"7d\"");
        expect(source).toContain('<button class="range-option active" data-range="7d" onclick="setUsageRange(\'7d\')" aria-pressed="true">近1周</button>');
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

    test('admin model activity shows all recent models independent from selected range', () => {
        const source = loadPotluckSource();

        expect(source).toContain('模型活跃度 (Models)');
        expect(source).toContain('const allModelSummary = summarizeUsageHistoryForRange(usageHistory, \'total\')');
        expect(source).toContain("renderDistribution('modelDistribution', allModelSummary.models, allModelCalls)");
        expect(source).not.toContain("document.getElementById('modelDistribution').innerHTML = '<div class=\"detail-empty\">当前范围暂无模型数据</div>'");
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
        expect(source).toContain('.usage-calendar-card { grid-column: span 3; }');
        expect(source).toContain('.usage-provider-card { grid-column: span 6; }');
        expect(source).toContain('.calendar-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 9px);');
        expect(source).toContain('.calendar-day { width: 9px; height: 9px;');
        expect(source).toContain('account-main-row');
        expect(source).toContain('account-calls');
        expect(source).toContain('account-token-row');
        expect(source).toContain('account-token-value');
        expect(source).toContain('account-token-share');
        expect(source).toContain('account-sub');
        expect(source).toContain('.account-sub {\n            display: none;');
        expect(source).toContain('isCodexOauthAccount(account)');
        expect(source).toContain('Object.entries(day.accounts || {})');
    });

    test('admin provider account tree preserves Codex account identity metadata', () => {
        const source = loadPotluckSource();

        expect(source).toContain('accountIdentity: account.accountIdentity ||');
        expect(source).toContain('accountEmail: account.accountEmail ||');
        expect(source).toContain('providerUuids: Array.isArray(account.providerUuids)');
        expect(source).toContain('account?.accountEmail || account?.providerName');
        expect(source).toContain('function isEmailLike(value)');
        expect(source).toContain("return value.split('@')[0];");
    });

    test('admin provider account tree renders every account without grouping into other accounts', () => {
        const source = loadPotluckSource();
        const start = source.indexOf('function renderProviderAccountRows(provider)');
        expect(start).toBeGreaterThanOrEqual(0);
        const end = source.indexOf('function renderProviderAccountTokenTree', start);
        expect(end).toBeGreaterThan(start);
        const block = source.slice(start, end);

        expect(block).toContain('const rows = provider.accounts.map(account =>');
        expect(block).not.toContain('provider.accounts.slice(0, 5)');
        expect(block).not.toContain('provider.accounts.length > 5');
        expect(block).not.toContain('其他账号');
    });

    test('admin dashboard exposes actual-default value controls and 35 day key detail history', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="conversionModelSelect"');
        expect(source).toContain("const ACTUAL_VALUE_MODE = 'actual'");
        expect(source).toContain("let currentConversionModel = ACTUAL_VALUE_MODE");
        expect(source).toContain('function setConversionModel(model)');
        expect(source).toContain('conversionModel=${encodeURIComponent(currentConversionModel)}');
        expect(source).toContain('function formatUsd(value)');
        expect(source).toContain('function getDisplayCostUsd(cost)');
        expect(source).toContain('function formatDisplayCost(cost)');
        expect(source).toContain('<option value="actual">真实</option>');
        expect(source).toContain('...models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)');
        expect(source).not.toContain('换算 ${escapeHtml(model)}');
        expect(source).toContain('function setConversionLoading(loading)');
        expect(source).toContain("toggle.classList.toggle('is-loading', loading)");
        expect(source).toContain('select.disabled = loading');
        expect(source).toContain('setConversionLoading(true)');
        expect(source).toContain('setConversionLoading(false)');
        expect(source).not.toContain('实际 <span class="cost-inline">');
        expect(source).not.toContain('换算 <span class="cost-inline alt">');
        expect(source).toContain('.slice(-35)');
        expect(source).toContain('summary.cost');
        expect(source).not.toContain('价格版本：2026-07-01 官方快照');
        expect(source).toContain('节点与 Token 使用统计 (最近 35 天)');
        expect(source).not.toContain('节点与 Token 使用统计 (最近 3 个月)');
    });

    test('admin key list defaults to sorting by current range tokens', () => {
        const source = loadPotluckSource();
        const rangeTokenOption = '<option value="rangeTokens-desc">当前范围 Token ↓</option>';
        const rangeCostOption = '<option value="rangeCost-desc">当前范围金额 ↓</option>';

        expect(source.indexOf(rangeTokenOption)).toBeGreaterThanOrEqual(0);
        expect(source.indexOf(rangeTokenOption)).toBeLessThan(source.indexOf(rangeCostOption));
        expect(source).toContain("else if (field === 'rangeTokens') { va = getKeyRangeMetrics(a).totalTokens; vb = getKeyRangeMetrics(b).totalTokens; }");
    });

    test('admin provider account tree rolls account cost up to provider headers', () => {
        const source = loadPotluckSource();

        expect(source).toContain('function addCostBucket(targetCost, sourceCost)');
        expect(source).toContain('function rollupProviderCostFromAccounts(provider)');
        expect(source).toContain('rollupProviderCostFromAccounts(provider)');
        expect(source).not.toContain("provider.summary?.cost ? ` · <span class=\"cost-inline\">${formatUsd(provider.summary.cost.actualUsd)}</span>`");
    });
});
