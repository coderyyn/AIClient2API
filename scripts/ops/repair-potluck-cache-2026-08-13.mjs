#!/usr/bin/env node
/**
 * One-time operational repair for the 2026-08-13 Potluck cache statistics incident.
 *
 * Default mode is read-only dry-run. Apply requires --apply and always creates a
 * backup plus SHA-256 manifest before atomically replacing api-potluck-keys.json.
 * This script intentionally does not touch request audit, request counts, or any
 * live service/container.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_DATE = '2026-08-13';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = process.env.USAGE_LEDGER_PRICING_FILE || path.resolve(SCRIPT_DIR, '../../src/plugins/api-potluck/pricing.json');
const PRICING = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function keyHash(key) { return `sha256:${sha256(key).slice(0, 16)}`; }
function writeJson(file, value) { return fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); }
function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
}
function rate(bucket) {
  const prompt = num(bucket?.promptTokens);
  return prompt > 0 ? Math.max(0, Math.min(1, num(bucket.cachedTokens) / prompt)) : null;
}
function baseline(history, model) {
  const dates = Object.keys(history || {}).filter(date => date < TARGET_DATE).sort().slice(-7);
  if (dates.length !== 7) return null;
  const modelRates = dates.map(date => rate(history[date]?.models?.[model])).filter(v => v !== null);
  if (modelRates.length === 7) return { rate: median(modelRates), source: 'estimated:key-model-7d-median', window: `${dates[0]}..${dates[6]}`, sampleDays: 7 };
  const keyRates = dates.map(date => rate(history[date]?.summary)).filter(v => v !== null);
  if (keyRates.length === 7) return { rate: median(keyRates), source: 'estimated:key-7d-median', window: `${dates[0]}..${dates[6]}`, sampleDays: 7 };
  return null;
}
function pricedModel(model) {
  const aliases = PRICING.modelPriceAliases || {};
  const normalized = String(model || 'unknown').toLowerCase();
  return aliases[normalized] || normalized;
}
function recalcCost(bucket, model) {
  const pricing = PRICING.pricePerMillion?.[pricedModel(model)];
  if (!pricing) return bucket?.cost || undefined;
  const prompt = num(bucket.promptTokens);
  const cached = Math.min(prompt, num(bucket.cachedTokens));
  const output = num(bucket.completionTokens);
  const actualUsd = ((Math.max(0, prompt - cached) * pricing.input) + cached * pricing.cachedInput + output * pricing.output) / 1_000_000;
  return { ...(bucket.cost || {}), actualUsd, convertedUsd: bucket.cost?.convertedUsd ?? actualUsd, missingPriceTokens: 0, pricingVersion: PRICING.pricingVersion, pricingModel: model };
}
function estimate(bucket, base) {
  if (!base || num(bucket?.promptTokens) <= 0) return null;
  const observed = Math.max(0, Math.round(num(bucket.cachedTokens)));
  const observedRate = observed / num(bucket.promptTokens);
  if (observed > 0 && observedRate >= base.rate * 0.25) return null;
  const estimated = Math.min(Math.round(num(bucket.promptTokens)), Math.max(0, Math.round(num(bucket.promptTokens) * base.rate)));
  if (estimated <= observed) return null;
  return { delta: estimated - observed, observed, estimated, base };
}
function walkBuckets(node, visit, pathParts = [], model = null) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if ('promptTokens' in node && 'cachedTokens' in node) visit(node, pathParts, model);
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nextModel = pathParts.at(-1) === 'models' ? key : model;
    walkBuckets(value, visit, [...pathParts, key], nextModel);
  }
}
function getAt(root, parts) { return parts.reduce((value, part) => value?.[part], root); }
function summarizeDay(day) {
  const summary = day?.summary || {};
  return { requestCount: num(summary.requestCount), promptTokens: num(summary.promptTokens), cachedTokens: num(summary.cachedTokens), completionTokens: num(summary.completionTokens), reasoningTokens: num(summary.reasoningTokens), totalTokens: num(summary.totalTokens), cost: summary.cost || null };
}
function parseArgs(argv) {
  const args = { base: process.cwd(), outDir: null, bundle: null, backupDir: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--base=')) args.base = arg.slice(7);
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice(10);
    else if (arg.startsWith('--bundle=')) args.bundle = arg.slice(9);
    else if (arg.startsWith('--backup-dir=')) args.backupDir = arg.slice(13);
    else if (arg === '--help') args.help = true;
  }
  return args;
}
async function atomicReplace(file, body) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node repair-potluck-cache-2026-08-13.mjs --base=<config-dir> --out-dir=<report-dir> [--apply --bundle=<report-dir> --backup-dir=<backup-dir>]');
    return;
  }
  const base = path.resolve(args.base);
  const outDir = path.resolve(args.bundle || args.outDir || path.join(base, `repair-cache-${TARGET_DATE}`));
  const potluckPath = path.join(base, 'api-potluck-keys.json');
  if (!fs.existsSync(potluckPath)) throw new Error(`missing ${potluckPath}`);
  if (!args.apply && fs.existsSync(outDir)) throw new Error(`output directory already exists: ${outDir}`);
  const store = JSON.parse(await fsp.readFile(potluckPath, 'utf8'));
  const next = clone(store);
  const patches = [];
  const before = {};
  const after = {};

  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const history = keyData?.usageHistory || {};
    const day = history[TARGET_DATE];
    if (!day || num(day.summary?.requestCount) <= 0) continue;
    const keyId = keyHash(rawKey);
    before[keyId] = summarizeDay(day);
    const nextDay = next.keys[rawKey].usageHistory[TARGET_DATE];
    walkBuckets(day, (bucket, bucketPath, model) => {
      const baseLine = baseline(history, model);
      const change = estimate(bucket, baseLine);
      if (!change) return;
      const target = getAt(nextDay, bucketPath);
      target.cachedTokens = num(target.cachedTokens) + change.delta;
      target.observedCachedTokens = change.observed;
      target.estimatedCachedTokens = change.estimated;
      target.cacheRateSource = change.base.source;
      target.dataQuality = change.observed > 0 ? 'mixed' : 'estimated';
      target.baseline = { window: change.base.window, sampleDays: change.base.sampleDays, medianCacheHitRatio: change.base.rate };
      target.cacheHitRatio = num(target.promptTokens) > 0 ? target.cachedTokens / num(target.promptTokens) : 0;
      if (model) target.cost = recalcCost(target, model);
      patches.push({ keyHash: keyId, date: TARGET_DATE, path: bucketPath, pathLabel: bucketPath.join('.'), model, deltaCachedTokens: change.delta, observedCachedTokens: change.observed, estimatedCachedTokens: change.estimated, dataQuality: target.dataQuality, cacheRateSource: target.cacheRateSource, baseline: target.baseline });
    });
    after[keyId] = summarizeDay(nextDay);
  }

  const summaryPatches = patches.filter(item => item.pathLabel === 'summary');
  const affectedKeyHashes = new Set(patches.map(item => item.keyHash));
  for (const keyId of Object.keys(before)) {
    if (!affectedKeyHashes.has(keyId)) { delete before[keyId]; delete after[keyId]; }
  }
  const report = { schemaVersion: 1, mode: 'dry-run', targetDate: TARGET_DATE, generatedAt: new Date().toISOString(), affectedKeys: affectedKeyHashes.size, patchCount: patches.length, summaryPatchCount: summaryPatches.length, totalDeltaCachedTokens: summaryPatches.reduce((sum, item) => sum + item.deltaCachedTokens, 0), anomalyThreshold: 'observed=0 or observedRate<25% of baseline', before, after };
  const manifest = { schemaVersion: 1, targetDate: TARGET_DATE, source: { path: path.basename(potluckPath), sha256: sha256File(potluckPath) }, patchSha256: sha256(JSON.stringify(patches)), apply: Boolean(args.apply) };
  if (!args.apply) {
    await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
    await writeJson(path.join(outDir, 'report.json'), report);
    await writeJson(path.join(outDir, 'patch.json'), { schemaVersion: 1, targetDate: TARGET_DATE, patches });
    await writeJson(path.join(outDir, 'before-summary.json'), before);
    await writeJson(path.join(outDir, 'after-summary.json'), after);
    await writeJson(path.join(outDir, 'manifest.json'), manifest);
  }

  if (args.apply) {
    if (!args.bundle) throw new Error('--bundle is required with --apply');
    const approvedManifest = JSON.parse(await fsp.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
    const approvedPatch = JSON.parse(await fsp.readFile(path.join(outDir, 'patch.json'), 'utf8'));
    if (approvedManifest.source?.sha256 !== sha256File(potluckPath)) throw new Error('source file changed since dry-run');
    if (approvedManifest.patchSha256 !== sha256(JSON.stringify(approvedPatch.patches || []))) throw new Error('patch hash mismatch');
    if (approvedPatch.targetDate !== TARGET_DATE) throw new Error('patch target date mismatch');
    const approvedPatches = approvedPatch.patches || [];
    const appliedNext = clone(store);
    const deltasByKey = {};
    for (const item of approvedPatches) {
      const rawKey = Object.keys(appliedNext.keys || {}).find(key => keyHash(key) === item.keyHash);
      if (!rawKey) throw new Error(`key hash no longer exists: ${item.keyHash}`);
      if (!Array.isArray(item.path)) throw new Error(`invalid patch path for ${item.keyHash}`);
      const target = getAt(appliedNext.keys[rawKey].usageHistory[TARGET_DATE], item.path);
      if (!target) throw new Error(`patch path no longer exists: ${item.keyHash}:${item.pathLabel || item.path.join('.')}`);
      target.cachedTokens = num(target.cachedTokens) + num(item.deltaCachedTokens);
      target.observedCachedTokens = num(item.observedCachedTokens);
      target.estimatedCachedTokens = num(item.estimatedCachedTokens);
      target.dataQuality = item.dataQuality;
      target.cacheRateSource = item.cacheRateSource;
      target.baseline = item.baseline;
      target.cacheHitRatio = num(target.promptTokens) > 0 ? target.cachedTokens / num(target.promptTokens) : 0;
      if (item.pathLabel === 'summary') {
        deltasByKey[rawKey] = (deltasByKey[rawKey] || 0) + num(item.deltaCachedTokens);
      }
    }
    for (const rawKey of Object.keys(appliedNext.keys || {})) {
      if (deltasByKey[rawKey]) {
        appliedNext.keys[rawKey].totalCachedTokens = num(appliedNext.keys[rawKey].totalCachedTokens) + deltasByKey[rawKey];
      }
    }
    if (!args.backupDir) throw new Error('--backup-dir is required with --apply');
    const backupDir = path.resolve(args.backupDir);
    if (fs.existsSync(backupDir)) throw new Error(`backup directory already exists: ${backupDir}`);
    await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await fsp.copyFile(potluckPath, path.join(backupDir, 'api-potluck-keys.json'));
    await writeJson(path.join(backupDir, 'backup-manifest.json'), { createdAt: new Date().toISOString(), source: path.basename(potluckPath), sha256: sha256File(potluckPath) });
    await atomicReplace(potluckPath, `${JSON.stringify(appliedNext, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'applied', backupDir, sourceSha256: approvedManifest.source.sha256, resultSha256: sha256File(potluckPath), affectedKeys: approvedPatches.length, totalDeltaCachedTokens: approvedPatches.reduce((sum, item) => sum + num(item.deltaCachedTokens), 0) }, null, 2));
  } else {
    console.log(JSON.stringify({ status: 'dry-run', outDir, affectedKeys: report.affectedKeys, patchCount: report.patchCount, totalDeltaCachedTokens: report.totalDeltaCachedTokens, sourceSha256: manifest.source.sha256 }, null, 2));
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
