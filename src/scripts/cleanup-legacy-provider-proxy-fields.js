#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const filePath = process.argv[2] || 'configs/provider_pools.json';
const resolvedPath = path.resolve(process.cwd(), filePath);

if (!existsSync(resolvedPath)) {
    console.error(`Provider pools file not found: ${resolvedPath}`);
    process.exit(1);
}

const backupPath = `${resolvedPath}.before-clean-legacy-proxy-${Date.now()}.bak`;
const data = JSON.parse(readFileSync(resolvedPath, 'utf8'));
let removedCount = 0;

for (const providers of Object.values(data)) {
    if (!Array.isArray(providers)) continue;
    for (const provider of providers) {
        if (!provider || typeof provider !== 'object') continue;
        for (const key of ['PROXY_URL', 'PROXY_REQUIRED']) {
            if (Object.prototype.hasOwnProperty.call(provider, key)) {
                delete provider[key];
                removedCount++;
            }
        }
    }
}

copyFileSync(resolvedPath, backupPath);
writeFileSync(resolvedPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
    filePath: resolvedPath,
    backupPath,
    removedCount
}, null, 2));
