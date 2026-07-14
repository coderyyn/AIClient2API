import { describe, expect, test } from '@jest/globals';
import { classifyCodexWindow, normalizeCodexRateLimitWindows } from '../src/utils/codex-rate-limit.js';

describe('Codex rate-limit window normalization', () => {
    test('classifies windows from their duration instead of source slot', () => {
        expect(classifyCodexWindow({ limit_window_seconds: 18000 })).toMatchObject({
            windowKind: 'short',
            durationSeconds: 18000
        });
        expect(classifyCodexWindow({ limitWindowSeconds: 604800 })).toMatchObject({
            windowKind: 'weekly',
            durationSeconds: 604800
        });
    });

    test('normalizes a weekly-only primary window as weekly', () => {
        const windows = normalizeCodexRateLimitWindows({
            rate_limit: {
                primary_window: {
                    used_percent: 3,
                    limit_window_seconds: 604800,
                    reset_at: 1784487507
                }
            }
        });

        expect(windows).toEqual([
            expect.objectContaining({
                id: 'primary_window',
                sourceWindow: 'primary_window',
                windowKind: 'weekly',
                durationSeconds: 604800,
                usedPercent: 3,
                scope: 'general'
            })
        ]);
    });
});
