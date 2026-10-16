import { describe, expect, test } from '@jest/globals';
import { rewriteProxyTimeContext } from '../src/providers/openai/codex-proxy-time-context.js';

const now = new Date('2026-01-01T01:00:00Z');
describe('Codex proxy time context', () => {
    test('uses the proxy date across midnight and leaves the original and user text intact', () => {
        const original = { input: [
            { role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<current_date>2026-01-01</current_date>\n<timezone>Asia/Shanghai</timezone>\n</environment_context>' }] },
            { role: 'user', content: 'Explain <timezone>Asia/Shanghai</timezone>' }
        ] };
        const { body, audit } = rewriteProxyTimeContext(original, 'America/Los_Angeles', now);
        expect(body.input[0].content[0].text).toContain('<current_date>2025-12-31</current_date>');
        expect(body.input[0].content[0].text).toContain('<timezone>America/Los_Angeles</timezone>');
        expect(body.input[1]).toEqual(original.input[1]);
        expect(original.input[0].content[0].text).toContain('Asia/Shanghai');
        expect(audit.action).toBe('replaced');
    });
    test('adds exactly one dedicated developer context for ordinary clients', () => {
        const first = rewriteProxyTimeContext({ input: 'hello' }, 'Asia/Tokyo', now).body;
        const second = rewriteProxyTimeContext(first, 'America/Los_Angeles', now).body;
        expect(second.input.filter(x => x.role === 'developer')).toHaveLength(1);
        expect(second.input.at(-1).content[0].text).toBe('hello');
        expect(JSON.stringify(second)).toContain('2025-12-31');
        expect(JSON.stringify(second)).not.toContain('Asia/Tokyo');
    });
    test('changes only the latest standalone automatic block and never tool or quoted content', () => {
        const block = '<environment_context><timezone>UTC</timezone><current_date>2020-01-01</current_date></environment_context>';
        const original = { input: [{ role: 'user', content: block }, { role: 'tool', content: block }, { role: 'user', content: block }] };
        const { body } = rewriteProxyTimeContext(original, 'Asia/Tokyo', now);
        expect(body.input[0].content).toBe(block);
        expect(body.input[1].content).toBe(block);
        expect(body.input[2].content).toContain('Asia/Tokyo');
    });
    test.each([['2026-01-01T12:00:00Z', 480], ['2026-07-01T12:00:00Z', 420]])('computes DST-aware existing offset at %s', (instant, offset) => {
        const { body } = rewriteProxyTimeContext({ input: 'hello', timezone: 'UTC', timezone_offset_min: 0 }, 'America/Los_Angeles', new Date(instant));
        expect(body.timezone).toBe('America/Los_Angeles');
        expect(body.timezone_offset_min).toBe(offset);
        expect(body).not.toHaveProperty('time_zone');
    });
});
