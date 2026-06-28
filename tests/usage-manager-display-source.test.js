import fs from 'fs';
import path from 'path';

describe('usage manager display source regressions', () => {
    test('usage details prefer backend-provided display values for token units', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const renderStart = source.indexOf('function renderUsageDetails(usage, accountSummary = null) {');
        expect(renderStart).toBeGreaterThanOrEqual(0);

        const renderEnd = source.indexOf('function getProviderDisplayName', renderStart);
        expect(renderEnd).toBeGreaterThan(renderStart);

        const renderBlock = source.slice(renderStart, renderEnd);
        expect(renderBlock).toContain('item.displayValue');
    });

    test('account usage summaries are indexed by identity and provider UUIDs', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('addIndex(account.accountKey, account)');
        expect(source).toContain('addIndex(getAccountUsageKey(account.provider, account.accountIdentity), account)');
        expect(source).toContain('(account.providerUuids || []).forEach(uuid =>');
        expect(source).toContain('instance.codexAccountKey');
        expect(source).toContain('account-usage-identity');
    });

    test('Codex usage cards render separate general and Codex 5.3 quota health badges', () => {
        const usageApiSource = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');
        const usageManagerSource = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(usageApiSource).toContain('codexQuotaHealth: provider.codexQuotaHealth || null');
        expect(usageApiSource).toContain('deriveCodexQuotaHealthFromUsage(instanceResult.codexQuotaHealth, usage)');
        expect(usageManagerSource).toContain('function renderCodexQuotaHealthBadges(instance, providerType)');
        expect(usageManagerSource).toContain("renderBadge('通用', quotaHealth.general)");
        expect(usageManagerSource).toContain("renderBadge('5.3', quotaHealth.codex53)");
        expect(usageManagerSource).not.toContain("renderBadge('通用额度'");
        expect(usageManagerSource).not.toContain("renderBadge('5.3额度'");
        expect(usageManagerSource).toContain('renderCodexQuotaHealthBadges(instance, providerType)');
    });

    test('usage refresh failures keep last successful cached data visible', () => {
        const usageApiSource = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');
        const usageManagerSource = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(usageApiSource).toContain('mergeUsageResultsWithLastSuccessfulCache');
        expect(usageApiSource).toContain('lastRefreshError');
        expect(usageApiSource).toContain('refreshErrors');
        expect(usageApiSource).toContain('readUsageCache({ maxAgeMs: null, allowStale: true })');
        expect(usageManagerSource).toContain('showUsageRefreshErrors(data.refreshErrors)');
    });
});
