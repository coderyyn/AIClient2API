import fs from 'fs';
import path from 'path';

function readSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('UI static file cache headers source', () => {
    test('static UI resources are served with no-store cache headers', () => {
        const source = readSource('src/services/ui-manager.js');
        const serveStart = source.indexOf('export async function serveStaticFiles');
        expect(serveStart).toBeGreaterThanOrEqual(0);
        const serveEnd = source.indexOf('/**\n * Handle UI management API requests', serveStart);
        expect(serveEnd).toBeGreaterThan(serveStart);
        const serveStaticFiles = source.slice(serveStart, serveEnd);

        expect(serveStaticFiles).toContain("'Cache-Control': 'no-cache, no-store, must-revalidate'");
        expect(serveStaticFiles).toContain("'Pragma': 'no-cache'");
        expect(serveStaticFiles).toContain("'Expires': '0'");
    });
});
