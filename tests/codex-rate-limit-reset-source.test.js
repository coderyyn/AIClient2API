import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('Codex rate limit reset source contracts', () => {
    test('usage API exposes a Codex-only reset endpoint through the backend', () => {
        const uiManagerSource = readFileSync('src/services/ui-manager.js', 'utf8');
        const usageApiSource = readFileSync('src/ui-modules/usage-api.js', 'utf8');

        expect(uiManagerSource).toContain('openai-codex-oauth');
        expect(uiManagerSource).toContain('/rate-limit-reset');
        expect(usageApiSource).toContain('handlePostCodexRateLimitReset');
        expect(usageApiSource).toContain('consumeRateLimitResetCredit');
    });

    test('usage page shows Codex reset credits only in the reset credits row', () => {
        const source = readFileSync('static/app/usage-manager.js', 'utf8');

        expect(source).toContain('rateLimitResetCredits');
        expect(source).toContain('formatCodexResetCreditsTooltip');
        expect(source).toContain('codex-reset-count" title="${escapeHtml(resetCreditsTooltip)}"');
        expect(source).not.toContain('class="btn-reset-codex-usage"');
        expect(source).toContain('btn-reset-codex-usage-inline');
        expect(source).toContain('confirmCodexRateLimitReset');
        expect(source).toContain('resetCodexRateLimit(');
        expect(source).toContain("item.id !== 'rate_limit_reset_credits'");
        expect(source).toContain('/rate-limit-reset');
    });

    test('usage page styles Codex reset controls as a compact action row', () => {
        const source = readFileSync('static/components/section-usage.css', 'utf8');

        expect(source).toContain('.usage-reset-credits');
        expect(source).toContain('.codex-reset-action-row');
        expect(source).toContain('.btn-reset-codex-usage-inline');
        expect(source).not.toContain('.btn-reset-codex-usage {');
    });
});
