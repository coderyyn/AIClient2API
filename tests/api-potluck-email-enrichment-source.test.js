import fs from 'fs';
import path from 'path';

describe('api potluck account email enrichment source', () => {
    test('potluck stats enrich account emails from provider pools and usage cache', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("configs', 'provider_pools.json'");
        expect(source).toContain("configs', 'usage-cache.json'");
        expect(source).toContain('instance?.usage?.user?.email || instance?.usage?.user?.label || instance?.codexEmail');
        expect(source).toContain('enrichPotluckStatsAccountEmails(await getStats())');
        expect(source).toContain('enrichAccountUsageSummaryEmails(await getAccountUsageSummary())');
    });
});
