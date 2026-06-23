import fs from 'fs';
import os from 'os';
import path from 'path';
import { RequestAuditStore } from '../src/plugins/request-audit/audit-store.js';

describe('request audit store', () => {
  test('persists and queries request audit jsonl by key hash and Beijing time window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-'));
    const store = new RequestAuditStore({ dir, retentionHours: 24 });

    await store.append({
      schemaVersion: 1,
      timestamp: '2026-06-23T09:10:00.000Z',
      beijingDate: '2026-06-23',
      beijingHour: '17',
      requestId: 'req-1',
      potluckKey: { hash: 'sha256:abc123' },
      request: { model: 'gpt-5.5', toProvider: 'openai-codex-oauth' },
      status: { outcome: 'success' },
      usage: { promptTokens: 1000, cachedTokens: 100 }
    });

    const rows = await store.query({
      keyHash: 'sha256:abc123',
      since: '2026-06-23T17:05:00+08:00',
      until: '2026-06-23T17:25:00+08:00'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe('req-1');
  });

  test('cleanup removes only expired audit jsonl files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-cleanup-'));
    const oldPath = path.join(dir, 'audit-2026-06-20.jsonl');
    const keepPath = path.join(dir, 'audit-2026-06-23.jsonl');
    const otherPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(oldPath, '{}\n');
    fs.writeFileSync(keepPath, '{}\n');
    fs.writeFileSync(otherPath, 'keep');

    const store = new RequestAuditStore({ dir, retentionHours: 24 });
    await store.cleanup(new Date('2026-06-24T00:00:00.000Z'));

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(keepPath)).toBe(true);
    expect(fs.existsSync(otherPath)).toBe(true);
  });
});
