import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BACKUP_FILES = [
    'provider_pools.json',
    'model-usage-stats.json',
    'usage-cache.json',
    'api-potluck-data.json',
    'api-potluck-keys.json',
    'config.json',
    'plugins.json'
];

const CODEX_ACCOUNT_PROVIDERS = new Set(['openai-codex-oauth', 'openaiResponses-custom']);

function isEmailLike(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeEmail(value) {
    return isEmailLike(value) ? value.trim().toLowerCase() : null;
}

function readJson(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function formatTimestampForPath(now) {
    return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
}

function createPermanentBackup(configDir, now) {
    const parentDir = path.dirname(configDir);
    const backupBase = path.join(
        parentDir,
        `ai_client_configs_backup_before_email_identity_migration_${formatTimestampForPath(now)}`
    );
    let backupDir = backupBase;
    let suffix = 1;
    while (fs.existsSync(backupDir)) {
        suffix += 1;
        backupDir = `${backupBase}_${suffix}`;
    }

    fs.mkdirSync(backupDir, { recursive: true });
    const missing = [];
    const sums = [];
    for (const fileName of BACKUP_FILES) {
        const source = path.join(configDir, fileName);
        if (!fs.existsSync(source)) {
            missing.push(fileName);
            continue;
        }
        const target = path.join(backupDir, fileName);
        fs.copyFileSync(source, target);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        sums.push(`${hash}  ${fileName}`);
    }

    if (missing.length > 0) {
        fs.writeFileSync(path.join(backupDir, 'missing-files.txt'), `${missing.join('\n')}\n`, 'utf8');
    }
    fs.writeFileSync(path.join(backupDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');
    fs.writeFileSync(path.join(backupDir, 'README.txt'), [
        'Purpose: permanent backup before Codex email identity migration.',
        'Do not delete unless the user explicitly says so.',
        `Created at: ${now.toISOString()}`,
        `Source dir: ${configDir}`,
        'Migration target: model-usage-stats email identity migration',
        ''
    ].join('\n'), 'utf8');

    return backupDir;
}

function buildProviderEmailIndex(providerPools = {}) {
    const index = new Map();
    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        if (!Array.isArray(providers)) continue;
        for (const provider of providers) {
            if (!provider?.uuid) continue;
            const email = normalizeEmail(provider.codexEmail)
                || normalizeEmail(provider.CODEX_EMAIL)
                || normalizeEmail(provider.email)
                || normalizeEmail(provider.customName);
            if (!email) continue;
            index.set(`${providerType}:${provider.uuid}`, email);
            index.set(provider.uuid, email);
        }
    }
    return index;
}

function getProviderFromAccountKey(accountKey) {
    return accountKey?.split(':')[0] || 'unknown';
}

function getIdentityFromAccountKey(accountKey) {
    return accountKey?.split(':').slice(1).join(':') || null;
}

function resolveAccountEmail(accountKey, account = {}, providerEmailIndex) {
    const provider = account.provider || getProviderFromAccountKey(accountKey);
    const directEmail = normalizeEmail(account.accountEmail)
        || normalizeEmail(account.accountIdentity)
        || normalizeEmail(account.providerName)
        || normalizeEmail(account.providerUuid)
        || normalizeEmail(getIdentityFromAccountKey(accountKey));
    if (directEmail) return directEmail;

    const candidates = [
        account.providerUuid,
        getIdentityFromAccountKey(accountKey),
        ...(Array.isArray(account.providerUuids) ? account.providerUuids : [])
    ].filter(Boolean);

    for (const uuid of candidates) {
        const email = providerEmailIndex.get(`${provider}:${uuid}`) || providerEmailIndex.get(uuid);
        if (email) return email;
    }

    return null;
}

function createEmptyUsage() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0,
        lastUsedAt: null
    };
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function addUsage(target, source = {}) {
    for (const key of ['requestCount', 'promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens', 'cachedTokens']) {
        target[key] = toNumber(target[key]) + toNumber(source[key]);
    }
    for (const key of ['maxQps', 'maxRpm', 'maxTps']) {
        target[key] = Math.max(toNumber(target[key]), toNumber(source[key]));
    }
    if (source.lastUsedAt && (!target.lastUsedAt || source.lastUsedAt > target.lastUsedAt)) {
        target.lastUsedAt = source.lastUsedAt;
    }
}

function mergeProviderUuids(target, account = {}) {
    const uuids = new Set(Array.isArray(target.providerUuids) ? target.providerUuids : []);
    if (account.providerUuid && !isEmailLike(account.providerUuid)) uuids.add(account.providerUuid);
    for (const uuid of account.providerUuids || []) {
        if (uuid && !isEmailLike(uuid)) uuids.add(uuid);
    }
    target.providerUuids = [...uuids];
}

function createEmailAccountStore(email, account = {}) {
    return {
        provider: 'openai-codex-oauth',
        providerUuid: email,
        accountIdentity: email,
        accountEmail: email,
        providerUuids: [],
        providerName: email,
        summary: createEmptyUsage(),
        models: {}
    };
}

function mergeAccountInto(target, source = {}, email) {
    target.provider = 'openai-codex-oauth';
    target.providerUuid = email;
    target.accountIdentity = email;
    target.accountEmail = email;
    target.providerName = email;
    mergeProviderUuids(target, source);
    addUsage(target.summary, source.summary);
    for (const [model, usage] of Object.entries(source.models || {})) {
        if (!target.models[model]) target.models[model] = createEmptyUsage();
        addUsage(target.models[model], usage);
    }
}

function migrateAccountMap(accounts = {}, providerEmailIndex, unmapped) {
    const migrated = {};
    for (const [accountKey, account] of Object.entries(accounts || {})) {
        const provider = account.provider || getProviderFromAccountKey(accountKey);
        if (!CODEX_ACCOUNT_PROVIDERS.has(provider)) {
            migrated[accountKey] = account;
            continue;
        }

        const email = resolveAccountEmail(accountKey, account, providerEmailIndex);
        if (!email) {
            unmapped.push(accountKey);
            continue;
        }

        const targetKey = `openai-codex-oauth:${email}`;
        if (!migrated[targetKey]) migrated[targetKey] = createEmailAccountStore(email, account);
        mergeAccountInto(migrated[targetKey], account, email);
    }
    return migrated;
}

function migrateEventMap(accountUsageEvents = {}, accountLookup) {
    const migrated = {};
    for (const [accountKey, events] of Object.entries(accountUsageEvents || {})) {
        const targetKey = accountLookup.get(accountKey);
        if (!targetKey) {
            migrated[accountKey] = events;
            continue;
        }
        migrated[targetKey] = [...(migrated[targetKey] || []), ...(Array.isArray(events) ? events : [])];
    }
    for (const events of Object.values(migrated)) {
        if (Array.isArray(events)) {
            events.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        }
    }
    return migrated;
}

function buildAccountLookup(accounts = {}, providerEmailIndex, unmapped) {
    const lookup = new Map();
    for (const [accountKey, account] of Object.entries(accounts || {})) {
        const provider = account.provider || getProviderFromAccountKey(accountKey);
        if (!CODEX_ACCOUNT_PROVIDERS.has(provider)) continue;
        const email = resolveAccountEmail(accountKey, account, providerEmailIndex);
        if (!email) {
            unmapped.push(accountKey);
            continue;
        }
        lookup.set(accountKey, `openai-codex-oauth:${email}`);
    }
    return lookup;
}

function sumAccountTokens(accounts = {}) {
    return Object.values(accounts || {}).reduce((sum, account) => sum + toNumber(account?.summary?.totalTokens), 0);
}

function sumDailyAccountTokens(daily = {}) {
    let total = 0;
    for (const day of Object.values(daily || {})) {
        total += sumAccountTokens(day?.accounts || {});
    }
    return total;
}

function countEvents(accountUsageEvents = {}) {
    return Object.values(accountUsageEvents || {}).reduce((sum, events) => sum + (Array.isArray(events) ? events.length : 0), 0);
}

function getTotals(stats = {}) {
    return {
        totalAccountTokens: sumAccountTokens(stats.accounts),
        totalDailyAccountTokens: sumDailyAccountTokens(stats.daily),
        eventCount: countEvents(stats.accountUsageEvents)
    };
}

function migrateStats(stats, providerEmailIndex) {
    const unmapped = [];
    const topLevelLookup = buildAccountLookup(stats.accounts || {}, providerEmailIndex, unmapped);
    const migrated = JSON.parse(JSON.stringify(stats));
    migrated.accounts = migrateAccountMap(stats.accounts || {}, providerEmailIndex, unmapped);
    migrated.accountUsageEvents = migrateEventMap(stats.accountUsageEvents || {}, topLevelLookup);

    for (const day of Object.values(migrated.daily || {})) {
        day.accounts = migrateAccountMap(day.accounts || {}, providerEmailIndex, unmapped);
    }

    const uniqueUnmapped = [...new Set(unmapped)];
    if (uniqueUnmapped.length > 0) {
        throw new Error(`Cannot migrate Codex accounts without email identity: ${uniqueUnmapped.join(', ')}`);
    }

    return migrated;
}

function migratePotluckUsageHistory(usageHistory = {}, providerEmailIndex) {
    const migrated = JSON.parse(JSON.stringify(usageHistory || {}));
    const unmapped = [];

    for (const day of Object.values(migrated)) {
        day.accounts = migrateAccountMap(day.accounts || {}, providerEmailIndex, unmapped);
        for (const hour of Object.values(day.hours || {})) {
            hour.accounts = migrateAccountMap(hour.accounts || {}, providerEmailIndex, unmapped);
        }
    }

    const uniqueUnmapped = [...new Set(unmapped)];
    if (uniqueUnmapped.length > 0) {
        throw new Error(`Cannot migrate Potluck Codex accounts without email identity: ${uniqueUnmapped.join(', ')}`);
    }

    return migrated;
}

function migratePotluckKeys(potluckKeys, providerEmailIndex) {
    const migrated = JSON.parse(JSON.stringify(potluckKeys || { keys: {} }));
    for (const keyData of Object.values(migrated.keys || {})) {
        keyData.usageHistory = migratePotluckUsageHistory(keyData.usageHistory || {}, providerEmailIndex);
    }
    return migrated;
}

function sumUsageHistoryAccountTokens(usageHistory = {}) {
    let total = 0;
    for (const day of Object.values(usageHistory || {})) {
        total += sumAccountTokens(day?.accounts || {});
        for (const hour of Object.values(day?.hours || {})) {
            total += sumAccountTokens(hour?.accounts || {});
        }
    }
    return total;
}

function getPotluckTotals(potluckKeys = {}) {
    let totalAccountTokens = 0;
    for (const keyData of Object.values(potluckKeys.keys || {})) {
        totalAccountTokens += sumUsageHistoryAccountTokens(keyData.usageHistory || {});
    }
    return { totalAccountTokens };
}

export async function migrateCodexEmailIdentity({ configDir = path.join(process.cwd(), 'configs'), now = new Date(), dryRun = false } = {}) {
    const providerPools = readJson(path.join(configDir, 'provider_pools.json'), {});
    const statsPath = path.join(configDir, 'model-usage-stats.json');
    const potluckKeysPath = path.join(configDir, 'api-potluck-keys.json');
    const stats = readJson(statsPath);
    if (!stats) {
        throw new Error(`Missing model usage stats file: ${statsPath}`);
    }
    const potluckKeys = readJson(potluckKeysPath, { keys: {} });

    const providerEmailIndex = buildProviderEmailIndex(providerPools);
    const totalsBefore = getTotals(stats);
    const migratedStats = migrateStats(stats, providerEmailIndex);
    const totalsAfter = getTotals(migratedStats);
    const potluckTotalsBefore = getPotluckTotals(potluckKeys);
    const migratedPotluckKeys = migratePotluckKeys(potluckKeys, providerEmailIndex);
    const potluckTotalsAfter = getPotluckTotals(migratedPotluckKeys);

    let backupDir = null;
    if (!dryRun) {
        backupDir = createPermanentBackup(configDir, now);
        writeJson(statsPath, migratedStats);
        if (fs.existsSync(potluckKeysPath)) {
            writeJson(potluckKeysPath, migratedPotluckKeys);
        }
    }

    return {
        backupDir,
        dryRun,
        totalsBefore,
        totalsAfter,
        potluckTotalsBefore,
        potluckTotalsAfter,
        accountCountBefore: Object.keys(stats.accounts || {}).length,
        accountCountAfter: Object.keys(migratedStats.accounts || {}).length
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const configDirArg = process.argv.find(arg => arg.startsWith('--config-dir='));
    const dryRun = process.argv.includes('--dry-run');
    migrateCodexEmailIdentity({
        configDir: configDirArg ? configDirArg.slice('--config-dir='.length) : undefined,
        dryRun
    }).then(result => {
        console.log(JSON.stringify(result, null, 2));
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
