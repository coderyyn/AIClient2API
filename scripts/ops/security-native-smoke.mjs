import assert from 'node:assert/strict';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const db = new Database(':memory:');
db.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
db.prepare('INSERT INTO smoke(value) VALUES (?)').run('synthetic');
assert.equal(db.prepare('SELECT value FROM smoke WHERE id = 1').get().value, 'synthetic');
const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
db.close();

for (const format of ['png', 'jpeg']) {
    const encoded = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#ff000080' } })[format]().toBuffer();
    const decoded = await sharp(encoded).resize(4, 3).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 4);
    assert.equal(decoded.info.height, 3);
    assert.equal(decoded.info.channels, format === 'png' ? 4 : 3);
}
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="red"/></svg>');
assert.equal((await sharp(svg).png().toBuffer({ resolveWithObject: true })).info.width, 8);
await assert.rejects(sharp(Buffer.from('invalid synthetic image')).png().toBuffer());

const child = spawn('/app/tls-sidecar/tls-sidecar', [], {
    env: { ...process.env, TLS_SIDECAR_PORT: '19090' }, stdio: 'ignore'
});
try {
    let response;
    for (let attempt = 0; attempt < 40; attempt++) {
        try { response = await fetch('http://127.0.0.1:19090/health'); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(response?.status, 200);
    assert.equal((await response.json()).status, 'ok');
} finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
}
console.log(JSON.stringify({ status: 'passed', node: process.version, sqliteVersion, sharp: sharp.versions,
    scenarios: ['sqlite-memory-read-write', 'png-alpha-resize', 'jpeg-resize', 'svg-render', 'invalid-image-rejection', 'sidecar-start-health-stop'] }));
