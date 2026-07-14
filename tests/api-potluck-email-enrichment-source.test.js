import fs from 'fs';
import path from 'path';

describe('api potluck account email enrichment source', () => {
    test('potluck stats enrich account emails from provider pools, credential files, and usage cache', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("configs', 'provider_pools.json'");
        expect(source).toContain("configs', 'usage-cache.json'");
        expect(source).toContain('function readProviderCredentialEmail(provider)');
        expect(source).toContain('extractCodexCredentialIdentity(data).codexEmail');
        expect(source).toContain('provider.codexEmail || readProviderCredentialEmail(provider)');
        expect(source).toContain('instance?.usage?.user?.email || instance?.usage?.user?.label || instance?.codexEmail');
        expect(source).toContain('enrichPotluckStatsAccountEmails(await getStats(getRequestCostOptions(req)))');
        expect(source).toContain('enrichAccountUsageSummaryEmails(await getAccountUsageSummary())');
    });
});
