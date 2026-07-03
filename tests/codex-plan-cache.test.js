import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { readFreshUsageCacheSync } from '../src/utils/codex-plan.js';

const originalCwd = process.cwd();
const tempDirs = [];

function writeUsageCache(root, marker, timestamp = new Date().toISOString()) {
    const configsDir = path.join(root, 'configs');
    fs.mkdirSync(configsDir, { recursive: true });
    fs.writeFileSync(path.join(configsDir, 'usage-cache.json'), JSON.stringify({
        timestamp,
        marker,
        providers: {}
    }), 'utf8');
}

afterEach(() => {
    process.chdir(originalCwd);
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('Codex usage cache reader', () => {
    test('uses a 1 hour default TTL for routing decisions', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-cache-'));
        tempDirs.push(root);
        process.chdir(root);

        writeUsageCache(root, 'within-default-ttl', new Date(Date.now() - 11 * 60 * 1000).toISOString());

        const cache = readFreshUsageCacheSync();

        expect(cache.marker).toBe('within-default-ttl');
    });

    test('reuses an unchanged fresh in-memory snapshot instead of reparsing the file on every routing decision', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-cache-'));
        tempDirs.push(root);
        process.chdir(root);

        writeUsageCache(root, 'first');
        const first = readFreshUsageCacheSync(60 * 1000);
        const second = readFreshUsageCacheSync(60 * 1000);

        expect(first.marker).toBe('first');
        expect(second).toBe(first);
        expect(second.marker).toBe('first');
    });

    test('refreshes the snapshot when the usage cache file changes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-cache-'));
        tempDirs.push(root);
        process.chdir(root);

        writeUsageCache(root, 'first');
        const first = readFreshUsageCacheSync(60 * 1000);

        writeUsageCache(root, 'second-and-longer');
        const second = readFreshUsageCacheSync(60 * 1000);

        expect(second).not.toBe(first);
        expect(second.marker).toBe('second-and-longer');
    });
});
