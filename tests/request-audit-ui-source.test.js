import { readFileSync } from 'fs';

describe('request audit ui source', () => {
  test('static report references summary api and context usage rows', () => {
    const html = readFileSync('static/request-audit.html', 'utf8');
    expect(html).toContain('/api/request-audit/summary');
    expect(html).toContain('context-stack');
    for (const id of ['instructions', 'tools', 'conversation', 'attachments', 'cached_input', 'output', 'reasoning']) {
      expect(html).toContain(id);
    }
  });
});
