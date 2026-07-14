import fs from 'fs';
import os from 'os';
import path from 'path';
import { RequestAuditAnalysisStore } from '../src/plugins/request-audit/analysis-store.js';

describe('request audit analysis store', () => {
  test('writes and reads diagnostics with freshness metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-analysis-'));
    const store = new RequestAuditAnalysisStore({ dir });
    const generatedAt = '2026-06-24T06:10:00.000Z';

    await store.writeDiagnostics([
      {
        requestId: 'req-1',
        primaryReason: 'prefix_changed',
        reasons: [{ code: 'prefix_changed', severity: 'high' }],
        confidence: 0.85
      }
    ], { generatedAt });

    const diagnostics = await store.readDiagnostics({ requestIds: ['req-1'] });
    const freshness = await store.readFreshness(new Date('2026-06-24T06:11:00.000Z'));

    expect(diagnostics['req-1']).toMatchObject({
      requestId: 'req-1',
      primaryReason: 'prefix_changed'
    });
    expect(freshness).toMatchObject({
      generatedAt,
      status: 'fresh'
    });
    expect(freshness.staleSeconds).toBe(60);
  });

  test('missing analysis returns empty diagnostics and missing freshness', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-analysis-empty-'));
    const store = new RequestAuditAnalysisStore({ dir });

    await expect(store.readDiagnostics({ requestIds: ['missing'] })).resolves.toEqual({});
    await expect(store.readFreshness()).resolves.toMatchObject({ status: 'missing' });
  });
});
