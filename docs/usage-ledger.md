# Usage Ledger Retention and Recompute

This document records the production usage-statistics ledger design used for API Potluck and request-audit based recompute. It intentionally documents the mechanism only. Do not commit production ledger files, `api-potluck-keys.json`, request-audit JSONL files, backups, API keys, OAuth tokens, cookies, or server credentials.

## Retention Policy

- Daily API key usage ledger: permanent JSONL.
- Hourly API key usage ledger: 35 days.
- Request-audit requestId detail: 35 days when `REQUEST_AUDIT_RETENTION_HOURS=840`.
- Recompute output: candidate JSONL files only. Review totals first, then replace the affected daily/hourly ledger files deliberately.

The default request-audit retention remains 24 hours in code. Production can extend it with:

```json
{
  "REQUEST_AUDIT_RETENTION_HOURS": 840
}
```

## Files

Production paths when the config volume is mounted at `/app/configs`:

```text
/app/configs/permanent-usage-ledger/daily/usage-YYYY-MM-DD.jsonl
/app/configs/permanent-usage-ledger/hourly/usage-YYYY-MM-DD.jsonl
/app/configs/permanent-usage-ledger/recompute-candidates/<timestamp>/
/app/configs/request-audit/audit-YYYY-MM-DD.jsonl
```

Repository tooling:

```text
scripts/usage-ledger/daily-usage-ledger.mjs
tests/usage-ledger/daily-usage-ledger.test.mjs
```

## Row Semantics

Daily ledger rows are keyed by date, provider/account, API key, and model.

- Prefer account/model details from `api-potluck-keys.json`.
- If old history has model/provider summary but no account detail, emit `source=api-potluck-keys-summary` with `accountKey=<provider>:unknown`.
- If account detail is partial, emit account rows plus `source=api-potluck-keys-summary-delta` rows for the positive model-level difference only. This preserves totals without double-counting account rows.
- Normalize historical model aliases before pricing and before computing summary deltas.
- Store `pricingVersion` on every row. The current version is `official-2026-07-09`.
- Pricing and model aliases live in the shared single source `src/plugins/api-potluck/pricing.json`, loaded by both `cost-estimator.js` and the ledger script. When running the ledger script standalone from the config volume (e.g. `/app/configs/tools/`), copy `pricing.json` next to the script or set `USAGE_LEDGER_PRICING_FILE`; inside the app container it falls back to `/app/src/plugins/api-potluck/pricing.json` automatically.

Key fields:

- `key`: original API Potluck key value, for the current production requirement that stats can be traced back to the original key.
- `keyHash`: truncated SHA-256 reference for matching request-audit events.
- `keyPrefix`: short display prefix.
- `keyName`: configured key name when available.

Because rows include `key`, the generated ledger is sensitive production config data. Keep ledger directories on the server/config volume only and out of git.

## Commands

Run tests:

```powershell
node --test .\tests\usage-ledger\daily-usage-ledger.test.mjs
```

Generate or replace ledgers from current API Potluck stats:

```bash
node /app/configs/tools/daily-usage-ledger.mjs write --base /app/configs --from 2026-04-24 --to 2026-07-06
```

Generate requestId-based recompute candidates without overwriting canonical ledgers:

```bash
node /app/configs/tools/daily-usage-ledger.mjs recompute-audit --base /app/configs --from 2026-07-05 --to 2026-07-05
```

Clean hourly ledger files older than 35 days:

```bash
node /app/configs/tools/daily-usage-ledger.mjs cleanup-hourly --base /app/configs --days 35
```

Reconcile daily totals across ledger, request-audit, and potluck stats:

```bash
node /app/configs/tools/daily-usage-ledger.mjs reconcile --base /app/configs --from 2026-07-05 [--to 2026-07-05] [--threshold 0.005]
```

The `reconcile` command writes `permanent-usage-ledger/reconciliation/reconcile-<date>.json` plus `latest.json`, prints a sanitized summary (no key material), and exits with code `2` when any comparison deviates beyond the threshold. The admin UI reads `latest.json` through `GET /api/potluck/reconciliation` and shows a status chip: green `ok`, amber `partial` (a source is missing), red `deviation`.

## Admin Range Stats From Ledger

`GET /api/potluck/range-stats?range=<total|30d|7d|today>&conversionModel=<model>` streams the daily ledger files for the requested Beijing-time date range and returns pre-aggregated `summary/providers/models/accounts` buckets (no key material). The potluck admin dashboard prefers this ledger source for the distribution panels and only adds live in-memory stats for dates missing from the ledger (normally today); the section title shows the data source, e.g. `数据源: 账本 6 天 + 实时 1 天 · official-2026-07-09`. When no ledger files exist the UI falls back to the previous full client-side aggregation.

Example production cron wrapper:

```sh
#!/bin/sh
set -eu
LOG_DIR=/root/ai_client_configs/permanent-usage-ledger/logs
mkdir -p "$LOG_DIR"
DAY=$(TZ=Asia/Shanghai date -d 'yesterday' +%F)
{
  echo "[$(date -Is)] write day=$DAY"
  docker exec aiclient2api node /app/configs/tools/daily-usage-ledger.mjs write --base /app/configs --from "$DAY" --to "$DAY"
  docker exec aiclient2api node /app/configs/tools/daily-usage-ledger.mjs cleanup-hourly --base /app/configs --days 35
  docker exec aiclient2api node /app/configs/tools/daily-usage-ledger.mjs reconcile --base /app/configs --from "$DAY" --to "$DAY" || echo "[$(date -Is)] reconcile deviation day=$DAY"
} >> "$LOG_DIR/usage-ledger-cron.log" 2>&1
```

Cron entry:

```cron
30 0 * * * root /root/ai_client_configs/tools/run-usage-ledger.sh
```

## Recompute Workflow

1. Confirm `REQUEST_AUDIT_RETENTION_HOURS=840` is active and the target dates still have request-audit files.
2. Run `recompute-audit` for the affected date range.
3. Compare candidate request/token/cost totals with the current ledger and expected incident scope.
4. Replace only the affected date files after review. Do not append candidate rows into canonical files.
5. Keep the candidate directory as short-lived investigation output or archive it outside git if needed.

`recompute-audit` deduplicates by `requestId` per key reference. When audit events only contain `keyHash/keyPrefix`, the tool loads current `api-potluck-keys.json` and enriches the original `key` if it can match the hash or prefix.

## Production Snapshot

On 2026-07-06, production `47.77.184.27` was backfilled and verified with:

- daily files: 68, `usage-2026-04-24.jsonl` through `usage-2026-07-06.jsonl`
- hourly files: 15, `usage-2026-06-22.jsonl` through `usage-2026-07-06.jsonl`
- closed-date verification: `2026-04-24..2026-07-05`
- verified closed-date totals: `2,470,521` requests and `39,104,441,202` tokens
- request-audit retention: `840` hours
- latest recompute candidate key enrichment: all daily candidate rows had original key populated
