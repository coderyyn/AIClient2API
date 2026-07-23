import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanRepairAuditFiles } from '../../scripts/usage-ledger/daily-usage-ledger.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-repair-memory-'));
const auditFile = path.join(root, 'audit-2026-07-20.jsonl');
const eventCount = 80000;

try {
  const handle = fs.openSync(auditFile, 'w');
  try {
    for (let start = 0; start < eventCount; start += 1000) {
      const lines = [];
      for (let index = start; index < Math.min(start + 1000, eventCount); index += 1) {
        lines.push(JSON.stringify({
          timestamp: '2026-07-20T16:10:00.000Z',
          beijingDate: '2026-07-21',
          requestId: `memory-${index}`,
          request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
          potluckKey: { present: false },
          account: { providerUuid: 'provider-1' },
          status: { outcome: 'success' },
          usage: { promptTokens: 1, totalTokens: 1 },
        }));
      }
      fs.writeSync(handle, `${lines.join('\n')}\n`);
    }
  } finally {
    fs.closeSync(handle);
  }

  const result = await scanRepairAuditFiles({
    files: [auditFile],
    from: '2026-07-21',
    to: '2026-07-21',
    collectEvents: false,
  });

  assert.equal(result.includedEventCount, eventCount);
  assert.equal(result.events, undefined);
  process.stdout.write(`${JSON.stringify({
    eventCount,
    heapUsedMiB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  })}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
