import { readFileSync } from 'fs';

describe('request audit ui source', () => {
  test('static report references summary api and context usage rows', () => {
    const html = readFileSync('static/request-audit.html', 'utf8');
    expect(html).toContain('/api/request-audit/summary');
    expect(html).toContain('/api/potluck/keys');
    expect(html).toContain('keySelect');
    expect(html).toContain('选择 Potluck Key');
    expect(html).toContain('手动输入完整 key');
    expect(html).toContain('本地计算 hash');
    expect(html).toContain('crypto.subtle.digest');
    expect(html).toContain("localStorage.getItem('authToken')");
    expect(html).toContain('Authorization');
    expect(html).toContain('keyRelatedNames');
    expect(html).toContain('关联：');
    expect(html).toContain('context-stack');
    expect(html).toContain('按密钥和时间窗复盘请求缓存率');
    expect(html).toContain('缓存命中率 =');
    expect(html).toContain('逐请求明细');
    expect(html).toContain('单次请求 token 分类');
    for (const id of ['instructions', 'tools', 'conversation', 'attachments', 'cached_input', 'output', 'reasoning']) {
      expect(html).toContain(id);
    }
  });
});
