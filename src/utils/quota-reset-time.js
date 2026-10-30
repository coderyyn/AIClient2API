const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function getZonedParts(timestamp, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
    return { year: values.year, month: values.month, day: values.day, asUtc: Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) };
}

// 当地 00:00 对应的 UTC 时间戳；先按当前偏移估算，再用目标时刻的偏移校正一次以覆盖夏令时。
function zonedMidnightToTimestamp(year, month, day, timezone) {
    const naive = Date.UTC(year, month - 1, day);
    let timestamp = naive - (getZonedParts(naive, timezone).asUtc - naive);
    timestamp = naive - (getZonedParts(timestamp, timezone).asUtc - timestamp);
    return timestamp;
}

/**
 * 下一次月度额度重置时间（当地 00:00，毫秒时间戳）。
 * day 超过当月天数时取当月最后一天；参数非法返回 null。
 */
export function getNextQuotaResetTime(day, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
    const resetDay = Number(day);
    if (day === null || day === undefined || day === '' || !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) return null;
    try {
        const current = getZonedParts(now, timezone || DEFAULT_TIMEZONE);
        const zone = timezone || DEFAULT_TIMEZONE;
        for (let offset = 0; offset < 2; offset++) {
            const monthIndex = current.month - 1 + offset;
            const year = current.year + Math.floor(monthIndex / 12);
            const month = (monthIndex % 12) + 1;
            const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
            const candidate = zonedMidnightToTimestamp(year, month, Math.min(resetDay, lastDay), zone);
            if (candidate > now) return candidate;
        }
        return null;
    } catch {
        return null;
    }
}
