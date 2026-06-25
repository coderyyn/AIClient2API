import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCodexCredentialDisplayName } from '../src/utils/codex-utils.js';

const originalCwd = process.cwd();
let tempDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-codex-link-'));
    process.chdir(tempDir);
});

afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Codex credential display name', () => {
    test('prefers email from the saved credential file', async () => {
        const filePath = path.join(tempDir, 'codex.json');
        fs.writeFileSync(filePath, JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            account_id: 'account-1',
            email: 'user@example.com'
        }, null, 2));

        await expect(readCodexCredentialDisplayName(filePath)).resolves.toBe('user@example.com');
    });

    test('falls back to name when email is missing', async () => {
        const filePath = path.join(tempDir, 'codex-name.json');
        fs.writeFileSync(filePath, JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            account_id: 'account-1',
            name: 'Account Alias'
        }, null, 2));

        await expect(readCodexCredentialDisplayName(filePath)).resolves.toBe('Account Alias');
    });
});
