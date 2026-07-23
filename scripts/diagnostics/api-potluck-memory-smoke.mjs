import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const targetMiB = Math.max(1, Number(process.argv[2]) || 62);
const targetBytes = Math.floor(targetMiB * 1024 * 1024);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-memory-'));
const configsDir = path.join(tempDir, 'configs');
const storePath = path.join(configsDir, 'api-potluck-keys.json');
const keyId = `maki_${'a'.repeat(32)}`;

function memoryMiB() {
    const memory = process.memoryUsage();
    return Object.fromEntries(
        ['rss', 'heapUsed', 'heapTotal', 'external'].map((name) => [
            name,
            Number((memory[name] / (1024 * 1024)).toFixed(1))
        ])
    );
}

try {
    fs.mkdirSync(configsDir, { recursive: true });
    const fixture = {
        keys: {
            [keyId]: {
                id: keyId,
                name: 'Memory Smoke',
                createdAt: '2026-07-23T00:00:00.000Z',
                dailyLimit: 1000,
                todayUsage: 0,
                totalUsage: 0,
                enabled: true,
                usageHistory: {},
                padding: 'x'.repeat(targetBytes)
            }
        }
    };
    fs.writeFileSync(storePath, JSON.stringify(fixture), { encoding: 'utf8', mode: 0o600 });
    const sourceBytes = fs.statSync(storePath).size;
    const beforeLoad = memoryMiB();

    process.chdir(tempDir);
    const keyManagerUrl = pathToFileURL(path.join(projectRoot, 'src', 'plugins', 'api-potluck', 'key-manager.js')).href;
    const keyManager = await import(keyManagerUrl);
    keyManager.setConfigGetter(() => ({
        persistInterval: 30_000,
        maxDirtyAge: 60_000,
        defaultDailyLimit: 500
    }));

    await keyManager.getKey(keyId, { summaryOnly: true, compactCosts: true });
    const afterLoad = memoryMiB();
    await keyManager.updateKeyName(keyId, 'Memory Smoke Persisted');
    const afterPersist = memoryMiB();
    const persistedBytes = fs.statSync(storePath).size;

    console.log(JSON.stringify({
        targetMiB,
        sourceBytes,
        persistedBytes,
        memoryMiB: { beforeLoad, afterLoad, afterPersist }
    }));
} finally {
    process.chdir(projectRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
}
