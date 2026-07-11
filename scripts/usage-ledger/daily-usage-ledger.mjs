#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Single pricing source shared with src/plugins/api-potluck/cost-estimator.js.
// Resolution order supports both in-repo runs and standalone copies under the
// config volume (e.g. /app/configs/tools/): env override, file next to this
// script, repo-relative path, then the in-container repo path.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolvePricingFile() {
  const candidates = [
    process.env.USAGE_LEDGER_PRICING_FILE,
    path.join(SCRIPT_DIR, 'pricing.json'),
    path.join(SCRIPT_DIR, '..', '..', 'src', 'plugins', 'api-potluck', 'pricing.json'),
    '/app/src/plugins/api-potluck/pricing.json',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'pricing.json not found. Copy src/plugins/api-potluck/pricing.json next to this script ' +
    'or set USAGE_LEDGER_PRICING_FILE.'
  );
}

const PRICING = JSON.parse(fs.readFileSync(resolvePricingFile(), 'utf8'));

export const PRICING_VERSION = PRICING.pricingVersion;

const PRICE_PER_MILLION = PRICING.pricePerMillion;

const MODEL_PRICE_ALIASES = PRICING.modelPriceAliases;

const MODEL_PRICE_MULTIPLIERS = PRICING.modelPriceMultipliers || {};

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeModelName(model) {
  const normalized = String(model || 'unknown').trim().toLowerCase();
  return MODEL_PRICE_ALIASES[normalized] || normalized || 'unknown';
}

function resolvePricedModel(model) {
  const normalized = String(model || 'unknown').trim().toLowerCase();
  const multiplierConfig = MODEL_PRICE_MULTIPLIERS[normalized];
  return {
    displayModel: normalizeModelName(normalized),
    pricedModel: normalizeModelName(multiplierConfig?.baseModel || normalized),
    multiplier: toNumber(multiplierConfig?.multiplier) || 1,
  };
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function inDateRange(date, { from, to } = {}) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function normalizeUsage(usage = {}) {
  return {
    requestCount: usage.requestCount !== undefined ? toNumber(usage.requestCount) : 1,
    promptTokens: toNumber(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens),
    cachedTokens: toNumber(
      usage.cachedTokens ??
      usage.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens
    ),
    completionTokens: toNumber(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens),
    reasoningTokens: toNumber(
      usage.reasoningTokens ??
      usage.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens
    ),
    totalTokens: toNumber(usage.totalTokens ?? usage.total_tokens) ||
      toNumber(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens) +
      toNumber(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens),
  };
}

function emptyUsage() {
  return {
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target, usage) {
  const normalized = normalizeUsage(usage);
  target.requestCount += normalized.requestCount;
  target.promptTokens += normalized.promptTokens;
  target.cachedTokens += normalized.cachedTokens;
  target.completionTokens += normalized.completionTokens;
  target.reasoningTokens += normalized.reasoningTokens;
  target.totalTokens += normalized.totalTokens;
}

function subtractUsage(total, covered) {
  const normalizedTotal = normalizeUsage(total);
  const normalizedCovered = normalizeUsage(covered);
  return {
    requestCount: Math.max(0, normalizedTotal.requestCount - normalizedCovered.requestCount),
    promptTokens: Math.max(0, normalizedTotal.promptTokens - normalizedCovered.promptTokens),
    cachedTokens: Math.max(0, normalizedTotal.cachedTokens - normalizedCovered.cachedTokens),
    completionTokens: Math.max(0, normalizedTotal.completionTokens - normalizedCovered.completionTokens),
    reasoningTokens: Math.max(0, normalizedTotal.reasoningTokens - normalizedCovered.reasoningTokens),
    totalTokens: Math.max(0, normalizedTotal.totalTokens - normalizedCovered.totalTokens),
  };
}

function hasUsageValue(usage) {
  const normalized = normalizeUsage(usage);
  return normalized.requestCount > 0 ||
    normalized.promptTokens > 0 ||
    normalized.cachedTokens > 0 ||
    normalized.completionTokens > 0 ||
    normalized.reasoningTokens > 0 ||
    normalized.totalTokens > 0;
}

export function hashSecret(value, length = 16) {
  if (!value) return null;
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

export function makeKeyRef(rawKey, keyName = null) {
  const text = String(rawKey || '');
  return {
    key: text || null,
    keyHash: hashSecret(text),
    keyPrefix: text ? `${text.slice(0, 11)}...` : null,
    keyName: keyName || null,
  };
}

export function buildKeyLookup(store = {}) {
  const byHash = new Map();
  const byPrefix = new Map();
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const ref = makeKeyRef(rawKey, keyData?.name);
    if (ref.keyHash) byHash.set(ref.keyHash, ref);
    if (ref.keyPrefix && !byPrefix.has(ref.keyPrefix)) byPrefix.set(ref.keyPrefix, ref);
  }
  return { byHash, byPrefix };
}

function makeAuditKeyRef(potluckKey = {}, keyLookup = null) {
  const rawKey = potluckKey.key || potluckKey.rawKey || null;
  if (rawKey) return makeKeyRef(rawKey, potluckKey.name || null);
  const hash = potluckKey.hash || potluckKey.keyHash || null;
  const prefix = potluckKey.prefix || potluckKey.keyPrefix || null;
  const matched = keyLookup?.byHash?.get(hash) || keyLookup?.byPrefix?.get(prefix) || null;
  if (matched) {
    return {
      ...matched,
      keyName: potluckKey.name || matched.keyName || null,
    };
  }
  return {
    key: null,
    keyHash: hash,
    keyPrefix: prefix,
    keyName: potluckKey.name || null,
  };
}

function canonicalAccount(account = {}, fallbackProvider = 'unknown') {
  const provider = account.provider || fallbackProvider || 'unknown';
  const email = normalizeEmail(account.accountEmail) ||
    normalizeEmail(account.accountIdentity) ||
    normalizeEmail(account.providerUuid) ||
    normalizeEmail(account.providerName);
  if (provider === 'openai-codex-oauth' && email) {
    return {
      provider: 'openai-codex-oauth',
      accountEmail: email,
      accountKey: `openai-codex-oauth:${email}`,
      accountIdentity: email,
    };
  }

  const identity = account.accountIdentity || account.providerUuid || 'unknown';
  return {
    provider,
    accountEmail: email,
    accountKey: `${provider}:${identity}`,
    accountIdentity: identity,
  };
}

function estimateUsageCost(usage, model) {
  const resolvedModel = resolvePricedModel(model);
  const pricing = PRICE_PER_MILLION[resolvedModel.pricedModel];
  if (!pricing) {
    return {
      actualUsd: 0,
      missingPriceTokens: normalizeUsage(usage).totalTokens,
      pricingModel: resolvedModel.displayModel,
    };
  }

  const normalized = normalizeUsage(usage);
  const cachedTokens = Math.min(normalized.promptTokens, normalized.cachedTokens);
  const billableInputTokens = Math.max(0, normalized.promptTokens - cachedTokens);
  const actualUsd = ((
    billableInputTokens * pricing.input +
    cachedTokens * pricing.cachedInput +
    normalized.completionTokens * pricing.output
  ) / 1_000_000) * resolvedModel.multiplier;

  return {
    actualUsd,
    missingPriceTokens: 0,
    pricingModel: resolvedModel.displayModel,
  };
}

function baseRow({
  date,
  hour = null,
  source,
  keyRef,
  account,
  providerUuids = [],
  providerName = null,
  model,
  usage,
}) {
  const normalizedUsage = normalizeUsage(usage);
  const cost = estimateUsageCost(normalizedUsage, model);
  return {
    schemaVersion: 1,
    ledgerType: hour === null ? 'daily-key-account-model' : 'hourly-key-account-model',
    date,
    ...(hour === null ? {} : { hour }),
    source,
    provider: account.provider,
    accountKey: account.accountKey,
    accountEmail: account.accountEmail,
    accountIdentity: account.accountIdentity,
    providerName,
    providerUuids: [...new Set(providerUuids.filter(Boolean))],
    ...keyRef,
    model: normalizeModelName(model),
    usage: normalizedUsage,
    cost: {
      actualUsd: cost.actualUsd,
      missingPriceTokens: cost.missingPriceTokens,
      pricingModel: cost.pricingModel,
    },
    pricingVersion: PRICING_VERSION,
  };
}

function rowGroupKey(row) {
  return [
    row.date,
    row.hour || '',
    row.provider,
    row.accountKey,
    row.keyHash || row.keyPrefix || '',
    row.model,
  ].join('\t');
}

function mergeRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = rowGroupKey(row);
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...row,
        usage: emptyUsage(),
        cost: { actualUsd: 0, missingPriceTokens: 0, pricingModel: row.cost?.pricingModel },
        providerUuids: [...row.providerUuids],
      });
    }
    const target = grouped.get(key);
    addUsage(target.usage, row.usage);
    target.providerUuids = [...new Set([...target.providerUuids, ...row.providerUuids])];
    target.cost.actualUsd += row.cost.actualUsd;
    target.cost.missingPriceTokens += row.cost.missingPriceTokens;
  }
  return [...grouped.values()].sort((a, b) => rowGroupKey(a).localeCompare(rowGroupKey(b)));
}

function rowsFromAccounts(accounts = {}, { date, hour = null, source, keyRef }) {
  const rows = [];
  for (const accountRecord of Object.values(accounts || {})) {
    const account = canonicalAccount(accountRecord, accountRecord.provider);
    const models = Object.entries(accountRecord.models || {});
    const sourceModels = models.length > 0 ? models : [['unknown', accountRecord.summary || {}]];
    for (const [model, usage] of sourceModels) {
      rows.push(baseRow({
        date,
        hour,
        source,
        keyRef,
        account,
        providerUuids: accountRecord.providerUuids || [accountRecord.providerUuid],
        providerName: accountRecord.providerName || null,
        model,
        usage,
      }));
    }
  }
  return rows;
}

function inferSingleProvider(record = {}) {
  const providers = Object.keys(record.providers || {}).filter(Boolean);
  return providers.length === 1 ? providers[0] : 'unknown';
}

function coveredUsageByModel(rows = []) {
  const covered = new Map();
  for (const row of rows) {
    const model = normalizeModelName(row.model);
    if (!covered.has(model)) covered.set(model, emptyUsage());
    addUsage(covered.get(model), row.usage);
  }
  return covered;
}

function aggregateUsageEntriesByModel(entries = []) {
  const grouped = new Map();
  for (const [model, usage] of entries) {
    const normalizedModel = normalizeModelName(model);
    if (!grouped.has(normalizedModel)) grouped.set(normalizedModel, emptyUsage());
    addUsage(grouped.get(normalizedModel), usage);
  }
  return [...grouped.entries()];
}

function rowsFromDaySummary(day = {}, { date, keyRef, coveredRows = [] }) {
  const provider = inferSingleProvider(day);
  const account = canonicalAccount({
    provider,
    accountIdentity: 'unknown',
  });
  const covered = coveredUsageByModel(coveredRows);
  const modelEntries = Object.entries(day.models || {});
  const sourceModels = modelEntries.length > 0
    ? aggregateUsageEntriesByModel(modelEntries)
    : (Object.keys(day.summary || {}).length > 0 ? [['unknown', day.summary]] : []);
  const source = coveredRows.length > 0 ? 'api-potluck-keys-summary-delta' : 'api-potluck-keys-summary';
  const rows = [];

  for (const [model, usage] of sourceModels) {
    const normalizedModel = normalizeModelName(model);
    const delta = subtractUsage(usage, covered.get(normalizedModel) || emptyUsage());
    if (!hasUsageValue(delta)) continue;
    rows.push(baseRow({
      date,
      source,
      keyRef,
      account,
      providerUuids: [],
      providerName: null,
      model,
      usage: delta,
    }));
  }

  return rows;
}

export function buildDailyRowsFromPotluck(store = {}, range = {}) {
  const rows = [];
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const keyRef = makeKeyRef(rawKey, keyData?.name);
    for (const [date, day] of Object.entries(keyData?.usageHistory || {})) {
      if (!inDateRange(date, range)) continue;
      const accountRows = rowsFromAccounts(day.accounts || {}, {
        date,
        source: 'api-potluck-keys',
        keyRef,
      });
      rows.push(...accountRows);
      rows.push(...rowsFromDaySummary(day, { date, keyRef, coveredRows: accountRows }));
    }
  }
  return mergeRows(rows);
}

export function buildHourlyRowsFromPotluck(store = {}, range = {}) {
  const rows = [];
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const keyRef = makeKeyRef(rawKey, keyData?.name);
    for (const [date, day] of Object.entries(keyData?.usageHistory || {})) {
      if (!inDateRange(date, range)) continue;
      for (const [hour, hourData] of Object.entries(day.hours || {})) {
        rows.push(...rowsFromAccounts(hourData.accounts || {}, {
          date,
          hour,
          source: 'api-potluck-keys',
          keyRef,
        }));
      }
    }
  }
  return mergeRows(rows);
}

function auditEventToRows(event, options = {}) {
  const date = event.beijingDate || String(event.timestamp || '').slice(0, 10);
  const hour = event.beijingHour || '00';
  const provider = event.request?.toProvider || event.request?.fromProvider || 'unknown';
  const accountRecord = {
    provider,
    providerUuid: event.account?.providerUuid || event.account?.accountEmail || null,
    accountEmail: event.account?.accountEmail || null,
    accountIdentity: event.account?.accountEmail || event.account?.providerUuid || null,
    providerName: event.account?.providerNameDisplay || null,
    providerUuids: [event.account?.providerUuid].filter(Boolean),
    models: {
      [event.request?.actualModel || event.request?.model || 'unknown']: {
        ...normalizeUsage(event.usage || {}),
        requestCount: 1,
      },
    },
  };
  const keyRef = makeAuditKeyRef(event.potluckKey || {}, options.keyLookup);
  const daily = rowsFromAccounts({ account: accountRecord }, { date, source: 'request-audit', keyRef });
  const hourly = rowsFromAccounts({ account: accountRecord }, { date, hour, source: 'request-audit', keyRef });
  return { daily, hourly };
}

export function aggregateAuditEvents(events = [], range = {}) {
  const seen = new Set();
  const skipped = {
    duplicateRequestIds: 0,
    outsideRange: 0,
    nonSuccess: 0,
    missingUsage: 0,
  };
  const dailyRows = [];
  const hourlyRows = [];

  for (const event of events) {
    const date = event.beijingDate || String(event.timestamp || '').slice(0, 10);
    if (!inDateRange(date, range)) {
      skipped.outsideRange += 1;
      continue;
    }
    if (event.status?.outcome && event.status.outcome !== 'success') {
      skipped.nonSuccess += 1;
      continue;
    }
    const usage = normalizeUsage(event.usage || {});
    if (usage.totalTokens <= 0 && usage.promptTokens <= 0 && usage.completionTokens <= 0) {
      skipped.missingUsage += 1;
      continue;
    }
    if (event.requestId) {
      const dedupeKey = `${event.potluckKey?.hash || ''}:${event.requestId}`;
      if (seen.has(dedupeKey)) {
        skipped.duplicateRequestIds += 1;
        continue;
      }
      seen.add(dedupeKey);
    }

    const rows = auditEventToRows(event, { keyLookup: range.keyLookup });
    dailyRows.push(...rows.daily);
    hourlyRows.push(...rows.hourly);
  }

  return {
    dailyRows: mergeRows(dailyRows),
    hourlyRows: mergeRows(hourlyRows),
    skipped,
    eventCount: events.length,
    includedRequestCount: seen.size,
  };
}

export function summarizeAggregationResult(result = {}) {
  return {
    eventCount: result.eventCount || 0,
    includedRequestCount: result.includedRequestCount || 0,
    skipped: result.skipped || {},
    dailyRows: Array.isArray(result.dailyRows) ? result.dailyRows.length : 0,
    hourlyRows: Array.isArray(result.hourlyRows) ? result.hourlyRows.length : 0,
  };
}

export function summarizeLedgerRows(rows = []) {
  const summary = { requestCount: 0, totalTokens: 0, actualUsd: 0, missingPriceTokens: 0, rowCount: rows.length };
  for (const row of rows) {
    const usage = normalizeUsage(row.usage || {});
    summary.requestCount += usage.requestCount;
    summary.totalTokens += usage.totalTokens;
    summary.actualUsd += toNumber(row.cost?.actualUsd);
    summary.missingPriceTokens += toNumber(row.cost?.missingPriceTokens);
  }
  return summary;
}

export function summarizePotluckDay(store = {}, date) {
  const summary = { requestCount: 0, totalTokens: 0 };
  let seen = false;
  for (const keyData of Object.values(store.keys || {})) {
    const day = keyData?.usageHistory?.[date];
    if (!day?.summary) continue;
    seen = true;
    const usage = normalizeUsage(day.summary);
    summary.requestCount += usage.requestCount;
    summary.totalTokens += usage.totalTokens;
  }
  return seen ? summary : null;
}

const RECONCILE_METRICS = ['requestCount', 'totalTokens'];

function compareSummaries(pair, left, right, thresholdRatio) {
  const metrics = {};
  let exceeded = false;
  for (const metric of RECONCILE_METRICS) {
    const a = toNumber(left?.[metric]);
    const b = toNumber(right?.[metric]);
    const base = Math.max(a, b);
    const deviationRatio = base === 0 ? 0 : Math.abs(a - b) / base;
    const metricExceeded = deviationRatio > thresholdRatio;
    if (metricExceeded) exceeded = true;
    metrics[metric] = { left: a, right: b, deviationRatio, exceeded: metricExceeded };
  }
  return { pair, metrics, exceeded };
}

export function reconcileDay({
  date,
  ledgerSummary = null,
  auditSummary = null,
  potluckSummary = null,
  thresholdRatio = 0.005,
} = {}) {
  const sources = {
    ledger: { available: ledgerSummary !== null, summary: ledgerSummary },
    audit: { available: auditSummary !== null, summary: auditSummary },
    potluck: { available: potluckSummary !== null, summary: potluckSummary },
  };

  const comparisons = [];
  if (ledgerSummary !== null && auditSummary !== null) {
    comparisons.push(compareSummaries('ledger-vs-audit', ledgerSummary, auditSummary, thresholdRatio));
  }
  if (ledgerSummary !== null && potluckSummary !== null) {
    comparisons.push(compareSummaries('ledger-vs-potluck', ledgerSummary, potluckSummary, thresholdRatio));
  }
  if (auditSummary !== null && potluckSummary !== null) {
    comparisons.push(compareSummaries('audit-vs-potluck', auditSummary, potluckSummary, thresholdRatio));
  }

  const allAvailable = Object.values(sources).every(source => source.available);
  const anyExceeded = comparisons.some(comparison => comparison.exceeded);
  const status = anyExceeded ? 'deviation' : (allAvailable ? 'ok' : 'partial');

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    date,
    status,
    thresholdRatio,
    pricingVersion: PRICING_VERSION,
    sources,
    comparisons,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function readJsonlFiles(files) {
  const rows = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // Ignore corrupted partial lines.
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
  return rows;
}

function rowsByDate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  return byDate;
}

async function atomicWriteJsonl(filePath, rows) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const body = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

async function writeRowsByDate(rows, outDir, prefix = 'usage') {
  const byDate = rowsByDate(rows);
  const written = [];
  for (const [date, dateRows] of byDate.entries()) {
    const filePath = path.join(outDir, `${prefix}-${date}.jsonl`);
    await atomicWriteJsonl(filePath, dateRows);
    written.push({ filePath, rowCount: dateRows.length });
  }
  return written.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function dateKeys(from, to) {
  const keys = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (const date = start; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function commandWrite(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  if (!from) throw new Error('--from is required');
  const store = await readJson(path.join(base, 'api-potluck-keys.json'));
  const ledgerRoot = args['ledger-dir'] || path.join(base, 'permanent-usage-ledger');
  const dailyRows = args.hourly ? [] : buildDailyRowsFromPotluck(store, { from, to });
  const hourlyRows = args.daily ? [] : buildHourlyRowsFromPotluck(store, { from, to });
  const result = {
    daily: await writeRowsByDate(dailyRows, path.join(ledgerRoot, 'daily')),
    hourly: await writeRowsByDate(hourlyRows, path.join(ledgerRoot, 'hourly')),
    dailyRows: dailyRows.length,
    hourlyRows: hourlyRows.length,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function commandRecomputeAudit(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  if (!from) throw new Error('--from is required');
  const auditDir = args['audit-dir'] || path.join(base, 'request-audit');
  const files = dateKeys(from, to).map(date => path.join(auditDir, `audit-${date}.jsonl`));
  const events = await readJsonlFiles(files);
  let keyLookup = null;
  try {
    keyLookup = buildKeyLookup(await readJson(path.join(base, 'api-potluck-keys.json')));
  } catch {
    keyLookup = null;
  }
  const result = aggregateAuditEvents(events, { from, to, keyLookup });
  const outRoot = args['out-dir'] || path.join(base, 'permanent-usage-ledger', 'recompute-candidates', new Date().toISOString().replace(/[:.]/g, ''));
  const written = {
    daily: await writeRowsByDate(result.dailyRows, path.join(outRoot, 'daily')),
    hourly: await writeRowsByDate(result.hourlyRows, path.join(outRoot, 'hourly')),
  };
  console.log(JSON.stringify({ ...summarizeAggregationResult(result), written }, null, 2));
}

async function readLedgerDailyRows(ledgerRoot, date) {
  const filePath = path.join(ledgerRoot, 'daily', `usage-${date}.jsonl`);
  if (!fs.existsSync(filePath)) return null;
  return readJsonlFiles([filePath]);
}

async function commandReconcile(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  if (!from) throw new Error('--from is required');
  const thresholdRatio = Number(args.threshold ?? 0.005);
  const ledgerRoot = args['ledger-dir'] || path.join(base, 'permanent-usage-ledger');
  const auditDir = args['audit-dir'] || path.join(base, 'request-audit');
  const outDir = args['out-dir'] || path.join(ledgerRoot, 'reconciliation');

  let store = null;
  let keyLookup = null;
  try {
    store = await readJson(path.join(base, 'api-potluck-keys.json'));
    keyLookup = buildKeyLookup(store);
  } catch {
    store = null;
  }

  const results = [];
  for (const date of dateKeys(from, to)) {
    const ledgerRows = await readLedgerDailyRows(ledgerRoot, date);
    const ledgerSummary = ledgerRows === null ? null : summarizeLedgerRows(ledgerRows);

    const auditFile = path.join(auditDir, `audit-${date}.jsonl`);
    let auditSummary = null;
    if (fs.existsSync(auditFile)) {
      const events = await readJsonlFiles([auditFile]);
      const aggregated = aggregateAuditEvents(events, { from: date, to: date, keyLookup });
      auditSummary = summarizeLedgerRows(aggregated.dailyRows);
    }

    const potluckSummary = store === null ? null : summarizePotluckDay(store, date);

    const result = reconcileDay({ date, ledgerSummary, auditSummary, potluckSummary, thresholdRatio });
    results.push(result);

    await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(result, null, 2);
    await fsp.writeFile(path.join(outDir, `reconcile-${date}.json`), body, { encoding: 'utf8', mode: 0o600 });
  }

  if (results.length > 0) {
    const latest = results[results.length - 1];
    await fsp.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  console.log(JSON.stringify({
    thresholdRatio,
    results: results.map(result => ({
      date: result.date,
      status: result.status,
      comparisons: result.comparisons.map(comparison => ({
        pair: comparison.pair,
        exceeded: comparison.exceeded,
      })),
    })),
  }, null, 2));

  if (results.some(result => result.status === 'deviation')) {
    process.exitCode = 2;
  }
}

async function commandCleanupHourly(args) {
  const base = args.base || process.cwd();
  const days = Number(args.days || 35);
  const hourlyDir = args['hourly-dir'] || path.join(base, 'permanent-usage-ledger', 'hourly');
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const deleted = [];
  if (fs.existsSync(hourlyDir)) {
    for (const name of await fsp.readdir(hourlyDir)) {
      const match = name.match(/^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match || match[1] >= cutoffKey) continue;
      const filePath = path.join(hourlyDir, name);
      await fsp.unlink(filePath);
      deleted.push(filePath);
    }
  }
  console.log(JSON.stringify({ cutoffKey, deleted }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'write') return commandWrite(args);
  if (command === 'recompute-audit') return commandRecomputeAudit(args);
  if (command === 'cleanup-hourly') return commandCleanupHourly(args);
  if (command === 'reconcile') return commandReconcile(args);
  throw new Error('Usage: daily-usage-ledger.mjs <write|recompute-audit|cleanup-hourly|reconcile> --base <dir> --from YYYY-MM-DD [--to YYYY-MM-DD]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
