import fs from 'fs';
import path from 'path';

describe('provider modal source regressions', () => {
    test('OAuth file path field rendering does not reference the next field definition', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        const branchStart = source.indexOf('} else if (field1IsOAuthFilePath) {');
        expect(branchStart).toBeGreaterThanOrEqual(0);

        const branchEnd = source.indexOf('        } else {\n            html += `', branchStart);
        expect(branchEnd).toBeGreaterThan(branchStart);

        const field1OAuthBranch = source.slice(branchStart, branchEnd);
        expect(field1OAuthBranch).not.toContain('field2Def');
    });
});
