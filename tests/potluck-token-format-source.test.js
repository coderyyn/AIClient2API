import fs from 'fs';
import path from 'path';

function extractBalancedBlock(source, marker) {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);

    const firstBrace = source.indexOf('{', start);
    expect(firstBrace).toBeGreaterThan(start);

    let depth = 0;
    for (let index = firstBrace; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{') depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                let end = index + 1;
                if (source[end] === ';') end += 1;
                return source.slice(start, end);
            }
        }
    }

    throw new Error(`Could not extract block for ${marker}`);
}

function loadTokenFormatter(relativePath, marker) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
    const formatTokenCompactSource = extractBalancedBlock(source, marker);
    const formatNumber = (num) => new Intl.NumberFormat('zh-CN').format(Number(num || 0));
    return new Function('formatNumber', `${formatTokenCompactSource}; return formatTokenCompact;`)(formatNumber);
}

function loadLimitFormatter() {
    const source = fs.readFileSync(path.join(process.cwd(), 'static/potluck.html'), 'utf8').replace(/\r\n/g, '\n');
    const formatNumberSource = extractBalancedBlock(source, 'function formatNumber(num)');
    const formatCompactNumberSource = extractBalancedBlock(source, 'function formatCompactNumber(value, units)');
    const formatCountCompactSource = extractBalancedBlock(source, 'function formatCountCompact(num)');
    const formatLimitCompactSource = extractBalancedBlock(source, 'function formatLimitCompact(limit)');
    return new Function(`${formatNumberSource}; ${formatCompactNumberSource}; ${formatCountCompactSource}; ${formatLimitCompactSource}; return formatLimitCompact;`)();
}

describe('API Potluck token display formatting', () => {
    test.each([
        ['static/potluck.html', 'function formatTokenCompact(num)'],
        ['static/potluck-user.html', 'const formatTokenCompact = (num) =>']
    ])('%s uses dynamic token units with two decimals', (relativePath, marker) => {
        const formatTokenCompact = loadTokenFormatter(relativePath, marker);

        expect(formatTokenCompact(0)).toBe('0');
        expect(formatTokenCompact(999)).toBe('999');
        expect(formatTokenCompact(1200)).toBe('1.20k');
        expect(formatTokenCompact(123456)).toBe('123.46k');
        expect(formatTokenCompact(999000000)).toBe('999.00M');
        expect(formatTokenCompact(1000000000)).toBe('1.00B');
        expect(formatTokenCompact(7400433719)).toBe('7.40B');
    });

    test('admin key limits use compact display and render unlimited as text', () => {
        const formatLimitCompact = loadLimitFormatter();

        expect(formatLimitCompact(0)).toBe('不限量');
        expect(formatLimitCompact(null)).toBe('不限量');
        expect(formatLimitCompact(999)).toBe('999');
        expect(formatLimitCompact(1200)).toBe('1.2k');
        expect(formatLimitCompact(10000)).toBe('1w');
        expect(formatLimitCompact(123456)).toBe('12.35w');
    });

    test('admin key limit modals expose unlimited controls', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/potluck.html'), 'utf8');

        expect(source).toContain('id="keyUnlimited"');
        expect(source).toContain('id="newLimitUnlimited"');
        expect(source).toContain('id="applyLimitUnlimited"');
        expect(source.match(/class="limit-control"/g) || []).toHaveLength(3);
        expect(source.match(/class="limit-mode-selector"/g) || []).toHaveLength(3);
        expect(source).toContain('data-limit-mode="limited"');
        expect(source).toContain('data-limit-mode="unlimited"');
        expect(source).toContain('showCreateModal');
        expect(source).toContain('保存为 0');
        expect(source).not.toContain('不限量，不拦截今日调用');
        expect(source).toContain('formatLimitCompact(key.dailyLimit)');
    });

    test('admin key list uses fixed identity and two-row action layout', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/potluck.html'), 'utf8');

        expect(source).toContain('max-width: 1680px');
        expect(source).toContain('grid-template-columns: 260px minmax(560px, 1fr) 312px');
        expect(source).toContain('grid-template-columns: repeat(4, minmax(135px, 1fr))');
        expect(source).toContain('grid-template-columns: repeat(3, 92px)');
        expect(source).toContain('.key-actions .btn-sm');
        expect(source).toContain('width: 92px');
        expect(source).toContain('@media (max-width: 1500px)');
    });
});
