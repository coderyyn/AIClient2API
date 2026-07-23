import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

function loadSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n');
}

function getFunctionSource(source, functionName) {
    const marker = `function ${functionName}(`;
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const remainingSource = source.slice(start + marker.length);
    const nextFunctionOffset = remainingSource.search(/\n\s*(?:async\s+)?function\s+[A-Za-z_$]/);
    const end = nextFunctionOffset >= 0
        ? start + marker.length + nextFunctionOffset
        : source.length;
    return source.slice(start, end);
}

describe('persistence pending UI handling', () => {
    test('model usage reset renders pending data and displays the server warning message', () => {
        const source = loadSource('static/model-usage-stats.html');
        const helper = getFunctionSource(source, 'renderResetResult');

        expect(source).toContain('.status.warning');
        expect(source).toMatch(/warning[^\n]+fa-triangle-exclamation|fa-triangle-exclamation[^\n]+warning/);
        expect(helper).toContain('payload.persistencePending');
        expect(helper).toContain('payload.message');
        expect(helper).toContain("'warning'");
        expect(getFunctionSource(source, 'resetData')).toContain('renderResetResult(payload');
        expect(getFunctionSource(source, 'resetTokenData')).toContain('renderResetResult(payload');
    });

    test('potluck management mutations share pending warning handling and still reveal a newly created key', () => {
        const source = loadSource('static/potluck.html');
        const helper = getFunctionSource(source, 'handleManagementMutationResult');

        expect(source).toContain('.toast.warning');
        expect(helper).toContain('result.persistencePending');
        expect(helper).toContain('result.message');
        expect(helper).toContain("'warning'");
        expect(helper).toContain('loadData()');

        for (const functionName of [
            'applyDailyLimitToAll',
            'createKey',
            'resetUsage',
            'resetTokenStats',
            'resetAllTokenStats',
            'updateLimit',
            'updateName',
            'toggleKey',
            'deleteKey'
        ]) {
            expect(getFunctionSource(source, functionName)).toContain('handleManagementMutationResult(result');
        }

        const createKeySource = getFunctionSource(source, 'createKey');
        expect(createKeySource.indexOf('currentNewKey = result.data.id'))
            .toBeLessThan(createKeySource.indexOf('handleManagementMutationResult(result'));
        expect(createKeySource.indexOf("openModal('showKeyModal')"))
            .toBeLessThan(createKeySource.indexOf('handleManagementMutationResult(result'));
    });
});
