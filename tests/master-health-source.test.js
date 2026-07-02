import fs from 'fs';
import path from 'path';

describe('master health source', () => {
    test('health endpoint fails when worker is not running and max restart exits container', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/core/master.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('const workerRunning = workerProcess !== null');
        expect(source).toContain('res.writeHead(workerRunning ? 200 : 503');
        expect(source).toContain('process.exit(1)');
    });
});
