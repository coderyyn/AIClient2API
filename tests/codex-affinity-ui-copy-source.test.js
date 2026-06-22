import { describe, expect, test } from '@jest/globals';
import fs from 'fs';

describe('Codex affinity UI copy', () => {
    test('describes sticky routing as conversation-first cache affinity instead of fixed account only', () => {
        const html = fs.readFileSync('static/components/section-config.html', 'utf8');
        const i18n = fs.readFileSync('static/app/i18n.js', 'utf8');

        expect(html).toContain('config.advanced.codexPotluckStickyProviderTitle');
        expect(i18n).toContain('Codex 缓存亲和路由');
        expect(i18n).toContain('优先按 prompt_cache_key/thread/session 固定到同一健康 Codex 账号');
    });
});
