import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const VALID = 'a'.repeat(64);
const EXPIRED = 'b'.repeat(64);
let tempDir;
let originalCwd;
let auth;

function writeStore(tokens) {
    writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({ tokens }));
}

const req = token => ({ headers: { authorization: `Bearer ${token}` }, url: '/api/config' });

describe('admin token store', () => {
    beforeAll(async () => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(path.join(os.tmpdir(), 'ui-auth-'));
        mkdirSync(path.join(tempDir, 'configs'));
        process.chdir(tempDir);
        // TOKEN_STORE_FILE is resolved from cwd at import time.
        auth = await import('../src/ui-modules/auth.js');
    });

    afterAll(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true });
    });

    test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('rejects prototype key %s', async (token) => {
        writeStore({});
        await expect(auth.checkAuth(req(token))).resolves.toBe(false);
        await expect(auth.checkAuth({ headers: {}, url: `/api/events?token=${token}` })).resolves.toBe(false);
    });

    test('accepts an issued token and rejects malformed or expired entries', async () => {
        writeStore({
            [VALID]: { expiryTime: Date.now() + 60_000 },
            [EXPIRED]: { expiryTime: Date.now() - 1 },
            ['c'.repeat(64)]: { expiryTime: 'never' },
            short: { expiryTime: Date.now() + 60_000 }
        });
        await expect(auth.checkAuth(req(VALID))).resolves.toBe(true);
        await expect(auth.checkAuth(req(EXPIRED))).resolves.toBe(false);
        await expect(auth.checkAuth(req('c'.repeat(64)))).resolves.toBe(false);
        await expect(auth.checkAuth(req('short'))).resolves.toBe(false);
        await expect(auth.checkAuth({ headers: { authorization: ['Bearer', VALID] }, url: '/api/config' })).resolves.toBe(false);
    });

    test('cleanup removes expired and malformed entries only', async () => {
        writeStore({
            [VALID]: { expiryTime: Date.now() + 60_000 },
            [EXPIRED]: { expiryTime: Date.now() - 1 },
            short: { expiryTime: Date.now() + 60_000 }
        });
        await auth.cleanupExpiredTokens();
        const stored = JSON.parse(readFileSync(path.join(tempDir, 'configs', 'token-store.json'), 'utf8'));
        expect(Object.keys(stored.tokens)).toEqual([VALID]);
    });

    test('rejects non-string or blank passwords before reading the stored password', async () => {
        await expect(auth.validateCredentials(undefined)).resolves.toBe(false);
        await expect(auth.validateCredentials({ length: 1 })).resolves.toBe(false);
        await expect(auth.validateCredentials('   ')).resolves.toBe(false);
    });
});
