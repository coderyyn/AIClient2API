#!/usr/bin/env node

import path from 'path';

import { rebuildUsageLedger } from '../plugins/usage-ledger/rebuild.js';

function readArg(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index === -1 || index + 1 >= process.argv.length) return fallback;
    return process.argv[index + 1];
}

async function main() {
    const configDir = path.join(process.cwd(), 'configs');
    const auditDir = readArg('--audit-dir', path.join(configDir, 'request-audit'));
    const ledgerDir = readArg('--ledger-dir', path.join(configDir, 'usage-ledger'));
    const modelUsagePath = readArg('--model-usage', path.join(configDir, 'model-usage-stats.json'));
    const retentionDays = Number(readArg('--retention-days', '35')) || 35;

    const result = await rebuildUsageLedger({
        auditDir,
        ledgerDir,
        modelUsagePath,
        retentionDays
    });

    console.log(JSON.stringify({
        ok: true,
        auditDir,
        ledgerDir,
        modelUsagePath,
        retentionDays,
        ...result
    }, null, 2));
}

main().catch(error => {
    console.error(JSON.stringify({
        ok: false,
        error: error.message
    }, null, 2));
    process.exitCode = 1;
});

