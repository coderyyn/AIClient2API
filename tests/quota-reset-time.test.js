import { describe, expect, test } from '@jest/globals';
import { getNextQuotaResetTime } from '../src/utils/quota-reset-time.js';

// Asia/Shanghai = UTC+8，无夏令时；重置发生在当地 00:00。
const iso = (value) => (value ? new Date(value).toISOString() : null);

describe('getNextQuotaResetTime', () => {
    test('returns this month when the reset day is still ahead', () => {
        expect(iso(getNextQuotaResetTime(14, 'Asia/Shanghai', Date.parse('2026-10-10T04:00:00Z'))))
            .toBe('2026-10-13T16:00:00.000Z');
    });

    test('rolls to next month once the reset moment has passed', () => {
        expect(iso(getNextQuotaResetTime(14, 'Asia/Shanghai', Date.parse('2026-10-30T01:00:00Z'))))
            .toBe('2026-11-13T16:00:00.000Z');
    });

    test('rolls over the year boundary', () => {
        expect(iso(getNextQuotaResetTime(14, 'Asia/Shanghai', Date.parse('2026-12-20T00:00:00Z'))))
            .toBe('2027-01-13T16:00:00.000Z');
    });

    test('clamps day 31 to the last day of shorter months', () => {
        expect(iso(getNextQuotaResetTime(31, 'Asia/Shanghai', Date.parse('2026-11-05T00:00:00Z'))))
            .toBe('2026-11-29T16:00:00.000Z');
        expect(iso(getNextQuotaResetTime(30, 'Asia/Shanghai', Date.parse('2027-02-01T00:00:00Z'))))
            .toBe('2027-02-27T16:00:00.000Z');
    });

    test('uses the timezone to decide whether the day has started', () => {
        // UTC 13日20:00 = 上海 14日04:00，已过 14 日 00:00 → 下月
        expect(iso(getNextQuotaResetTime(14, 'Asia/Shanghai', Date.parse('2026-10-13T20:00:00Z'))))
            .toBe('2026-11-13T16:00:00.000Z');
        expect(iso(getNextQuotaResetTime(14, 'UTC', Date.parse('2026-10-13T20:00:00Z'))))
            .toBe('2026-10-14T00:00:00.000Z');
    });

    test('returns null for invalid days or timezones', () => {
        for (const day of [0, 32, 1.5, 'abc', null, undefined]) {
            expect(getNextQuotaResetTime(day, 'Asia/Shanghai', Date.now())).toBeNull();
        }
        expect(getNextQuotaResetTime(14, 'Not/AZone', Date.now())).toBeNull();
    });
});
