import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeConfig } from '../src/core/config-manager.js';
import { Logger } from '../src/utils/logger.js';

const originalLogRetentionDays = process.env.LOG_RETENTION_DAYS;
let consoleSpies = [];
let tempDirs = [];

function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-logs-'));
    tempDirs.push(dir);
    return dir;
}

function writeLogFile(dir, name, ageDays) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, `${name}\n`, 'utf8');
    const timestamp = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, timestamp, timestamp);
    return filePath;
}

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];

    if (originalLogRetentionDays === undefined) {
        delete process.env.LOG_RETENTION_DAYS;
    } else {
        process.env.LOG_RETENTION_DAYS = originalLogRetentionDays;
    }
});

describe('log retention configuration', () => {
    test('defaults request body limit to 100 MiB', async () => {
        delete process.env.REQUEST_BODY_MAX_BYTES;
        delete process.env.REQUEST_BODY_MAX_MB;

        const config = await initializeConfig([], 'configs/missing-test-config.json');

        expect(config.REQUEST_BODY_MAX_BYTES).toBe(100 * 1024 * 1024);
    });

    test('defaults log retention to 7 days', async () => {
        delete process.env.LOG_RETENTION_DAYS;

        const config = await initializeConfig([], 'configs/missing-test-config.json');

        expect(config.LOG_RETENTION_DAYS).toBe(7);
    });

    test('uses LOG_RETENTION_DAYS from the environment', async () => {
        process.env.LOG_RETENTION_DAYS = '3';

        const config = await initializeConfig([], 'configs/missing-test-config.json');

        expect(config.LOG_RETENTION_DAYS).toBe(3);
    });

    test('uses --log-retention-days from CLI args', async () => {
        delete process.env.LOG_RETENTION_DAYS;

        const config = await initializeConfig(['--log-retention-days', '14'], 'configs/missing-test-config.json');

        expect(config.LOG_RETENTION_DAYS).toBe(14);
    });
});

describe('log retention cleanup', () => {
    test('deletes app log files older than the configured retention days', () => {
        const logDir = makeTempDir();
        const oldLog = writeLogFile(logDir, 'app-2026-01-01.log', 8);
        const recentLog = writeLogFile(logDir, 'app-2026-01-08.log', 2);
        const otherFile = writeLogFile(logDir, 'notes.log', 30);

        const logger = new Logger();
        logger.initialize({
            outputMode: 'console',
            logDir,
            maxFiles: 100,
            retentionDays: 7
        });

        logger.cleanupOldLogs();

        expect(fs.existsSync(oldLog)).toBe(false);
        expect(fs.existsSync(recentLog)).toBe(true);
        expect(fs.existsSync(otherFile)).toBe(true);
    });
});

describe('log sanitization', () => {
    test('redacts email addresses from general logger output', () => {
        const logger = new Logger();
        logger.initialize({
            outputMode: 'console',
            includeTimestamp: false,
            includeRequestId: false
        });

        logger.info('Initialized account user@example.com');

        const logged = consoleSpies.find(spy => spy.getMockName?.() === 'log')?.mock?.calls?.[0]?.[0]
            || console.log.mock.calls[0][0];
        expect(logged).not.toContain('user@example.com');
        expect(logged).toContain('[redacted-email:');
    });

    test('redacts query API keys and bearer tokens from general logger output', () => {
        const logger = new Logger();
        logger.initialize({
            outputMode: 'console',
            includeTimestamp: false,
            includeRequestId: false
        });

        logger.info('GET /v1/models?key=0123456789abcdef0123456789abcdef Authorization=Bearer abcdef0123456789abcdef0123456789');

        const logged = console.log.mock.calls[0][0];
        expect(logged).not.toContain('0123456789abcdef0123456789abcdef');
        expect(logged).not.toContain('abcdef0123456789abcdef0123456789');
        expect(logged).toContain('key=[redacted:');
        expect(logged).toContain('Bearer [redacted:');
    });
});
