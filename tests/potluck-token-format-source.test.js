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
});
