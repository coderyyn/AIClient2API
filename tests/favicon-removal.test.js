import fs from 'fs';
import path from 'path';

describe('favicon removal', () => {
    test('returns an empty 204 response before static file lookup', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'ui-manager.js'), 'utf8');
        const faviconBranch = source.indexOf("pathParam === '/favicon.ico'");
        const staticLookup = source.indexOf("path.join(process.cwd(), 'static'", source.indexOf('export async function serveStaticFiles'));

        expect(faviconBranch).toBeGreaterThanOrEqual(0);
        expect(faviconBranch).toBeLessThan(staticLookup);
        expect(source.slice(faviconBranch, staticLookup)).toContain('res.writeHead(204');
        expect(source.slice(faviconBranch, staticLookup)).toContain("res.end('')");
    });

    test('does not keep local favicon binaries or HTML favicon declarations', () => {
        expect(fs.existsSync(path.join(process.cwd(), 'static', 'favicon.ico'))).toBe(false);
        expect(fs.existsSync(path.join(process.cwd(), 'static', 'favicon0.ico'))).toBe(false);

        for (const relativePath of ['static/index.html', 'static/login.html']) {
            const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
            expect(source).not.toMatch(/<link[^>]+rel=["'](?:shortcut )?icon["']/i);
        }
    });
});
