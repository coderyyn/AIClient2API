import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir;
const originalCwd = process.cwd();

async function loadKeyManager() {
  jest.resetModules();
  return await import('../src/plugins/api-potluck/key-manager.js');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-audit-link-'));
  process.chdir(tempDir);
  fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('potluck audit link metadata', () => {
  test('listKeys exposes audit query metadata without leaking full key', async () => {
    const { createKey, listKeys } = await loadKeyManager();
    const created = await createKey('Audit Key', 1000);
    const [listed] = await listKeys();

    expect(listed.audit).toMatchObject({
      keyHash: expect.stringMatching(/^sha256:/),
      summaryPath: expect.stringContaining('/api/request-audit/summary')
    });
    expect(JSON.stringify(listed.audit)).not.toContain(created.id);
  });
});
