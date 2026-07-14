import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { RequestAuditRawCaptureStore, shouldCaptureRawRequest } from '../src/plugins/request-audit/raw-capture-store.js';

describe('request audit raw capture', () => {
  test('is disabled by default and only allows configured key hashes', () => {
    expect(shouldCaptureRawRequest({ enabled: false }, { potluckKey: { hash: 'sha256:a' } })).toBe(false);
    expect(shouldCaptureRawRequest({ enabled: true, keyHashes: ['sha256:a'] }, { potluckKey: { hash: 'sha256:b' } })).toBe(false);
    expect(shouldCaptureRawRequest({ enabled: true, keyHashes: ['sha256:a'] }, { potluckKey: { hash: 'sha256:a' } })).toBe(true);
  });

  test('writes gzipped raw request under safe directory with byte cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-'));
    const store = new RequestAuditRawCaptureStore({ dir, maxBytes: 80 });

    const result = await store.capture({
      requestId: 'req-raw',
      timestamp: '2026-06-24T06:00:00.000Z',
      potluckKey: { hash: 'sha256:key' },
      originalRequestBody: { input: `secret-${'x'.repeat(200)}` }
    });

    expect(result.captured).toBe(true);
    expect(result.path.startsWith(dir)).toBe(true);
    expect(result.path).toMatch(/req-raw\.json\.gz$/);
    const raw = zlib.gunzipSync(fs.readFileSync(result.path)).toString('utf8');
    expect(raw).toContain('truncated');
    expect(raw).not.toContain('x'.repeat(120));
  });

  test('cleanup removes expired raw capture files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-cleanup-'));
    const store = new RequestAuditRawCaptureStore({ dir, ttlMinutes: 60 });

    await store.capture({
      requestId: 'old',
      timestamp: '2026-06-24T06:00:00.000Z',
      originalRequestBody: { input: 'old' }
    });
    await store.capture({
      requestId: 'new',
      timestamp: '2026-06-24T07:30:00.000Z',
      originalRequestBody: { input: 'new' }
    });
    await store.cleanup(new Date('2026-06-24T08:00:00.000Z'));

    const files = listFiles(dir);
    expect(files.some(file => file.endsWith('old.json.gz'))).toBe(false);
    expect(files.some(file => file.endsWith('new.json.gz'))).toBe(true);
  });
});

function listFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(fullPath));
    else result.push(fullPath);
  }
  return result;
}
