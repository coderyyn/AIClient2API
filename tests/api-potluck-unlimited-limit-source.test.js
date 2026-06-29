import fs from 'fs';
import path from 'path';

describe('API Potluck unlimited daily limit source contract', () => {
    test('bulk apply limit accepts zero as unlimited', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8');
        const routeStart = source.indexOf("path === '/api/potluck/keys/apply-limit'");
        expect(routeStart).toBeGreaterThanOrEqual(0);

        const routeSource = source.slice(routeStart, source.indexOf("path === '/api/potluck/keys'", routeStart));
        expect(routeSource).toContain('dailyLimit < 0');
        expect(routeSource).not.toContain('dailyLimit < 1');
        expect(routeSource).toContain('formatDailyLimitMessage(dailyLimit)');
    });
});
