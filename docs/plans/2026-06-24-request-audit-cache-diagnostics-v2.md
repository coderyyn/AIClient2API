# Request Audit Cache Diagnostics v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an accurate, low-risk cache diagnostics layer for `request-audit` so we can explain why a key has low cache hit rate without making the request hot path slow.

**Architecture:** Keep the request hot path lightweight: append safe audit events and bounded fingerprints only. Run cache-miss diagnosis as a delayed analyzer over persisted audit events and optional short-lived raw captures. `request-audit.html` should show the latest materialized diagnosis with an explicit freshness timestamp instead of pretending to be perfectly real-time.

**Tech Stack:** Node.js ESM, built-in HTTP server, existing plugin manager, JSONL files under `/app/configs`, static HTML/CSS/JS, Jest tests, Docker.

**Project Progress Doc:** `AGENTS.md` branch notes and this plan under `docs/plans/`.
**Test Overview Doc:** existing focused Jest tests under `tests/request-audit-*.test.js`.

---

## Scope

### In Scope

- Add raw-free request fingerprints that help diagnose cache misses:
  - canonical payload hash
  - prompt shape hash
  - system/instructions hash
  - tools schema hash
  - metadata/settings hash
  - approximate prefix hashes for stable windows
  - section lengths and counts
- Add delayed cache diagnostics:
  - `prefix_changed`
  - `tools_changed`
  - `instructions_changed`
  - `model_changed`
  - `account_changed`
  - `short_prompt_or_low_cacheable_input`
  - `attachment_or_multimodal_variance`
  - `unknown_or_upstream_cache_ttl`
- Add materialized analysis storage so the UI can read fast results.
- Add `request-audit.html` UI sections for:
  - analysis freshness
  - likely miss reasons
  - nearest comparable request
  - same key/model/account stability indicators
- Add optional short-lived raw capture for explicitly scoped debugging:
  - disabled by default
  - scoped by key hash and time window
  - TTL cleanup
  - max bytes per request
  - no raw prompt in normal summary or table API responses
- Local branch workflow:
  - implement on local `yyn/customized-branch`
  - run focused tests
  - run local container smoke
  - send real local request through the container
  - commit
  - only then update 47.77.196.94

### Not In Scope

- No always-on long-term raw prompt archive.
- No database migration.
- No external queue service.
- No exposing raw prompt in `request-audit.html`.
- No changing upstream provider routing logic.
- No pushing git commits unless explicitly requested.

## Engineering Review

### Data Flow

```text
request completed
  -> request-audit hook
  -> append lightweight audit event
  -> enqueue bounded fingerprint work
  -> write audit-YYYY-MM-DD.jsonl
  -> delayed analyzer reads audit events
  -> write analysis-YYYY-MM-DD.jsonl or analysis-cache.json
  -> request-audit APIs return audit + diagnosis
  -> request-audit.html shows stale-safe diagnosis
```

### Performance Boundary

- Request hooks must not do deep tokenization or unbounded traversal.
- Fingerprint generation must be bounded by:
  - max characters per field
  - max array items
  - max object keys
  - max wall-clock budget per event where feasible
- Analyzer may be delayed and batch-based.
- UI queries must read materialized analysis, not compute large diffs on demand.

### Security Boundary

- Default audit stores hashes, counts, lengths, model, provider, key hash, account display hash, and usage only.
- Raw capture is a separate dangerous mode:
  - explicit config only
  - scoped key hashes
  - short TTL
  - 0600 file mode
  - no token/cookie/key logging
  - do not commit captured data

---

## Task 1: Add Fingerprint Builder Tests First

**Files:**
- Create: `tests/request-audit-fingerprint.test.js`
- Create: `src/plugins/request-audit/fingerprint.js`

**Step 1: Write failing tests**

Test cases:

- Same normalized request produces same `payloadHash`.
- Tool schema order normalization is stable when equivalent keys are reordered.
- Different system instruction changes `instructionsHash`.
- Different tools changes `toolsHash`.
- Large prompt does not appear in serialized fingerprint output.
- Large prompt is processed within a bounded time in test scale.

Example assertions:

```js
expect(fingerprint.payloadHash).toMatch(/^sha256:/);
expect(JSON.stringify(fingerprint)).not.toContain('secret prompt text');
expect(fingerprint.sections.conversation.charLength).toBeGreaterThan(0);
expect(fingerprint.sections.tools.hash).toMatch(/^sha256:/);
```

**Step 2: Run failing test**

```powershell
npm test -- tests/request-audit-fingerprint.test.js --runInBand
```

Expected: FAIL because `fingerprint.js` does not exist.

**Step 3: Implement minimal `fingerprint.js`**

Implementation requirements:

- Export `buildRequestFingerprint({ originalRequestBody, processedRequestBody })`.
- Prefer `processedRequestBody` when available for upstream-cache diagnosis.
- Never return raw text.
- Return bounded hashes/counts:
  - `payloadHash`
  - `shapeHash`
  - `instructionsHash`
  - `toolsHash`
  - `metadataHash`
  - `prefixHashes`
  - `sections`
- Use stable JSON stringify with sorted object keys and bounded traversal.

**Step 4: Run test**

```powershell
npm test -- tests/request-audit-fingerprint.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/fingerprint.js tests/request-audit-fingerprint.test.js
git commit -m "feat: 新增请求审计指纹构建"
```

---

## Task 2: Attach Fingerprints to Audit Events Without Blocking

**Files:**
- Modify: `src/plugins/request-audit/audit-event.js`
- Modify: `src/plugins/request-audit/index.js`
- Modify: `tests/request-audit-event.test.js`
- Modify: `tests/request-audit-plugin.test.js`

**Step 1: Write failing tests**

Add assertions:

- Default event includes `fingerprint`.
- Event JSON does not include raw prompt.
- `onContentGenerated` returns quickly even with a large prompt.
- Fingerprint failure logs warning but does not throw into plugin manager.

**Step 2: Run failing tests**

```powershell
npm test -- tests/request-audit-event.test.js tests/request-audit-plugin.test.js --runInBand
```

Expected: FAIL because event has no fingerprint yet.

**Step 3: Implement**

Implementation requirements:

- Keep `deepContextBreakdown=false` by default.
- Build fingerprint in the existing background audit queue, not synchronously in `onContentGenerated`.
- Add queue pressure protection:
  - keep current max queue behavior
  - drop fingerprint details if queue is overloaded, but still write basic usage event
- Add event field:

```js
fingerprint: {
  version: 1,
  payloadHash,
  shapeHash,
  sections,
  prefixHashes,
  warnings: []
}
```

**Step 4: Run tests**

```powershell
npm test -- tests/request-audit-event.test.js tests/request-audit-plugin.test.js tests/request-audit-fingerprint.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/audit-event.js src/plugins/request-audit/index.js tests/request-audit-event.test.js tests/request-audit-plugin.test.js
git commit -m "feat: 为请求审计事件记录安全指纹"
```

---

## Task 3: Add Cache Diagnostics Analyzer

**Files:**
- Create: `src/plugins/request-audit/cache-diagnostics.js`
- Create: `tests/request-audit-cache-diagnostics.test.js`

**Step 1: Write failing tests**

Test diagnosis rules:

- Same key/model/account but changed prefix hash returns `prefix_changed`.
- Same key/model/account but changed tools hash returns `tools_changed`.
- Same key/model but different account returns `account_changed`.
- Same key/account but different model returns `model_changed`.
- Low prompt tokens returns `short_prompt_or_low_cacheable_input`.
- Missing comparable event returns `unknown_or_upstream_cache_ttl`.

**Step 2: Run failing test**

```powershell
npm test -- tests/request-audit-cache-diagnostics.test.js --runInBand
```

Expected: FAIL because analyzer does not exist.

**Step 3: Implement analyzer**

Export:

```js
export function diagnoseCacheMiss(event, candidates = [])
export function buildDiagnostics(events = [])
```

Output shape:

```js
{
  requestId,
  cacheHitRatio,
  primaryReason,
  reasons: [
    { code, severity, evidence }
  ],
  comparableRequestId,
  confidence
}
```

**Step 4: Run test**

```powershell
npm test -- tests/request-audit-cache-diagnostics.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/cache-diagnostics.js tests/request-audit-cache-diagnostics.test.js
git commit -m "feat: 增加缓存命中诊断规则"
```

---

## Task 4: Materialize Analysis Store

**Files:**
- Create: `src/plugins/request-audit/analysis-store.js`
- Modify: `src/plugins/request-audit/api-routes.js`
- Create: `tests/request-audit-analysis-store.test.js`
- Modify: `tests/request-audit-api.test.js`

**Step 1: Write failing tests**

Test:

- Writes and reads diagnostics by date.
- Summary API includes `analysisFreshness`.
- Requests API can attach diagnosis by `requestId`.
- Missing analysis file returns empty diagnosis, not error.

**Step 2: Run failing tests**

```powershell
npm test -- tests/request-audit-analysis-store.test.js tests/request-audit-api.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement store**

Recommended storage:

```text
configs/request-audit-analysis/analysis-YYYY-MM-DD.jsonl
configs/request-audit-analysis/latest.json
```

Do not compute full diagnostics inside HTTP request handlers. API should read materialized files only.

**Step 4: Run tests**

```powershell
npm test -- tests/request-audit-analysis-store.test.js tests/request-audit-api.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/analysis-store.js src/plugins/request-audit/api-routes.js tests/request-audit-analysis-store.test.js tests/request-audit-api.test.js
git commit -m "feat: 持久化请求审计诊断结果"
```

---

## Task 5: Add Delayed Analyzer Runner

**Files:**
- Modify: `src/plugins/request-audit/index.js`
- Create: `tests/request-audit-analyzer-runner.test.js`

**Step 1: Write failing tests**

Test:

- Runner starts when plugin enabled.
- Runner does not block `onContentGenerated`.
- Runner respects interval config.
- Runner handles malformed audit lines.
- Runner can be disabled independently.

**Step 2: Run failing test**

```powershell
npm test -- tests/request-audit-analyzer-runner.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement runner**

Config keys:

```js
REQUEST_AUDIT_ANALYZER_ENABLED=true
REQUEST_AUDIT_ANALYZER_INTERVAL_MS=60000
REQUEST_AUDIT_ANALYZER_LOOKBACK_MINUTES=180
REQUEST_AUDIT_ANALYZER_MAX_EVENTS=5000
```

Behavior:

- `setInterval(...).unref()`
- analyze recent events only
- write materialized diagnostics
- log errors without disabling plugin

**Step 4: Run tests**

```powershell
npm test -- tests/request-audit-analyzer-runner.test.js tests/request-audit-plugin.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/index.js tests/request-audit-analyzer-runner.test.js
git commit -m "feat: 后台分析请求缓存诊断"
```

---

## Task 6: Update API Response Shape

**Files:**
- Modify: `src/plugins/request-audit/api-routes.js`
- Modify: `tests/request-audit-api.test.js`

**Step 1: Write failing tests**

Expected API additions:

`/api/request-audit/summary`:

```json
{
  "analysisFreshness": {
    "generatedAt": "ISO",
    "staleSeconds": 60,
    "status": "fresh|stale|missing"
  },
  "diagnosticsSummary": {
    "prefix_changed": 3,
    "tools_changed": 1
  }
}
```

`/api/request-audit/requests` should attach:

```json
{
  "diagnosis": {
    "primaryReason": "prefix_changed",
    "reasons": []
  }
}
```

**Step 2: Run failing tests**

```powershell
npm test -- tests/request-audit-api.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement**

Keep API backward compatible:

- Existing fields stay unchanged.
- New fields are additive.
- If analysis missing, return `status: "missing"` and no error.

**Step 4: Run tests**

```powershell
npm test -- tests/request-audit-api.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/api-routes.js tests/request-audit-api.test.js
git commit -m "feat: 在请求审计 API 返回缓存诊断"
```

---

## Task 7: Update `request-audit.html`

**Files:**
- Modify: `static/request-audit.html`
- Modify: `tests/request-audit-ui-source.test.js`

**Step 1: Write failing UI source test**

Assert HTML includes:

- `分析延迟`
- `可能原因`
- `prefix_changed`
- `tools_changed`
- `account_changed`
- `analysisFreshness`
- `诊断结果仅供排查`

**Step 2: Run failing test**

```powershell
npm test -- tests/request-audit-ui-source.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement UI**

Add:

- Top notice: "分析结果可能延迟 1-5 分钟，以准确和低负载为优先。"
- Summary card: top reason counts.
- Row detail: "可能原因" list with evidence.
- Freshness pill:
  - fresh
  - stale
  - missing

No raw prompt display.

**Step 4: Run test**

```powershell
npm test -- tests/request-audit-ui-source.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add static/request-audit.html tests/request-audit-ui-source.test.js
git commit -m "feat: 展示缓存诊断原因"
```

---

## Task 8: Optional Scoped Raw Capture

**Files:**
- Create: `src/plugins/request-audit/raw-capture-store.js`
- Modify: `src/plugins/request-audit/index.js`
- Create: `tests/request-audit-raw-capture.test.js`

**Step 1: Write failing tests**

Test:

- Raw capture disabled by default.
- Raw capture only writes for configured key hash.
- Raw capture respects TTL.
- Raw capture respects max bytes.
- Raw capture path is under configured safe directory.
- Raw capture output is not returned by summary/requests APIs.

**Step 2: Run failing tests**

```powershell
npm test -- tests/request-audit-raw-capture.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement**

Config:

```js
REQUEST_AUDIT_RAW_CAPTURE_ENABLED=false
REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES=[]
REQUEST_AUDIT_RAW_CAPTURE_TTL_MINUTES=60
REQUEST_AUDIT_RAW_CAPTURE_MAX_BYTES=1048576
REQUEST_AUDIT_RAW_CAPTURE_DIR=configs/request-audit-raw
```

Storage:

```text
configs/request-audit-raw/YYYY-MM-DD/<requestId>.json.gz
```

Security:

- mode `0600`
- no full key in filename
- cleanup expired files
- log only counts and request IDs

**Step 4: Run tests**

```powershell
npm test -- tests/request-audit-raw-capture.test.js tests/security-hardening-logs-path.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/raw-capture-store.js src/plugins/request-audit/index.js tests/request-audit-raw-capture.test.js
git commit -m "feat: 增加限定范围原始请求采集"
```

---

## Task 9: Local Full Verification

**Files:**
- No source change expected.

**Step 1: Run focused test suite**

```powershell
npm test -- tests/request-audit-fingerprint.test.js tests/request-audit-cache-diagnostics.test.js tests/request-audit-analysis-store.test.js tests/request-audit-analyzer-runner.test.js tests/request-audit-raw-capture.test.js tests/request-audit-plugin.test.js tests/request-audit-context-breakdown.test.js tests/request-audit-event.test.js tests/request-audit-store.test.js tests/request-audit-api.test.js tests/request-audit-ui-source.test.js tests/request-audit-potluck-link.test.js tests/security-hardening-logs-path.test.js --runInBand
```

Expected: all pass.

**Step 2: Build local image**

```powershell
$short = (git rev-parse --short HEAD)
docker build -t "aiclient2api:customized-branch-$short-cache-diagnostics-local" .
```

Expected: build succeeds.

**Step 3: Restart local test container**

Use the existing local test container if present, otherwise create one with local configs.

Suggested detection:

```powershell
docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | Select-String "aiclient2api"
```

Expected: identify local test container before replacing anything.

**Step 4: Verify local endpoints**

```powershell
curl.exe -sS -o NUL -w "health %{http_code} %{time_total}`n" http://127.0.0.1:3000/api/health
curl.exe -sS -o NUL -w "audit %{http_code} %{time_total}`n" http://127.0.0.1:3000/request-audit.html
```

Expected: 200 and fast response.

**Step 5: Send real local upstream requests**

Use a safe tiny prompt and the local configured potluck key.

Required real-request checks:

- Send two near-identical `gpt-5.5` requests.
- Send one request with a changed instruction or tool shape.
- Verify audit file adds at least 3 rows.
- Verify analyzer produces diagnosis for the changed request.
- Verify `/api/usage` still returns promptly after the requests.

Example shape, with real key supplied from local config/UI and not committed:

```powershell
curl.exe -sS http://127.0.0.1:3000/v1/responses `
  -H "Authorization: Bearer <local-test-key>" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"gpt-5.5\",\"input\":[{\"role\":\"user\",\"content\":\"cache diagnostics smoke: answer ok\"}],\"store\":false}"
```

Expected:

- upstream request succeeds
- audit line appears
- worker CPU does not stay above 70%
- `/api/health` remains under 1s

**Step 6: Commit final verification note if docs changed**

Only commit if a verification doc or test fixture changed. Do not commit generated logs or raw captures.

---

## Task 10: Remote 94 Deployment

**Files:**
- No source change expected.

**Precondition:**

- Local tests pass.
- Local container smoke passes.
- Local real upstream request smoke passes.
- Working tree clean.
- Latest local commit is ready.

**Step 1: Build source archive from local HEAD**

```powershell
$short = (git rev-parse --short HEAD)
$out = Join-Path $env:TEMP "aiclient2api-$short.tar"
git archive --format=tar -o $out HEAD
```

Expected: archive created.

**Step 2: Upload to 47.77.196.94 and build image**

Remote image naming:

```text
aiclient2api:customized-branch-<short>-request-audit-cache-diagnostics-20260624
```

Expected: `docker build` succeeds.

**Step 3: Backup current remote container**

Backup name:

```text
aiclient2api_before_<short>_<YYYYMMDDHHmm>
```

Keep the existing mount:

```text
/root/ai_client_configs:/app/configs
```

Keep current port mappings.

**Step 4: Start new container**

Do not change production config except the plugin config required by this feature.

Default production settings:

```json
{
  "REQUEST_AUDIT_ENABLED": true,
  "REQUEST_AUDIT_DEEP_CONTEXT_BREAKDOWN": false,
  "REQUEST_AUDIT_ANALYZER_ENABLED": true,
  "REQUEST_AUDIT_RAW_CAPTURE_ENABLED": false
}
```

**Step 5: Remote verification**

Run:

```bash
docker inspect aiclient2api --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
curl -m 10 -sS -o /dev/null -w 'api-health http=%{http_code} time=%{time_total}\n' http://127.0.0.1:3000/api/health
curl -m 10 -sS -o /dev/null -w 'audit-page http=%{http_code} time=%{time_total}\n' http://127.0.0.1:3000/request-audit.html
curl -m 20 -sS -H "Authorization: Bearer <token-from-token-store>" -o /tmp/usage.json -w 'usage http=%{http_code} time=%{time_total}\n' http://127.0.0.1:3000/api/usage
docker stats --no-stream aiclient2api
```

Expected:

- health is `healthy`
- `/api/health` under 1s
- `/request-audit.html` under 1s
- `/api/usage` returns 200 in a reasonable time
- CPU does not stay above 70%
- memory does not grow continuously during observation

**Step 6: Observe real traffic**

Observe for at least 3 minutes:

```bash
for i in 1 2 3 4 5 6; do
  sleep 30
  curl -m 5 -sS -o /dev/null -w 'health %{http_code} %{time_total}\n' http://127.0.0.1:3000/api/health
  docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}}' aiclient2api
  wc -l /root/ai_client_configs/request-audit/audit-$(date -u +%Y-%m-%d).jsonl 2>/dev/null || true
done
```

Expected:

- audit rows continue to increase
- CPU remains stable
- no plugin timeout or auto-disable logs

**Step 7: Rollback conditions**

Rollback immediately if any condition holds:

- `/api/health` times out twice in a row.
- `/request-audit.html` times out twice in a row.
- `/api/usage` times out after the deploy when it was healthy before.
- CPU stays above 70% for more than 60 seconds without known legitimate traffic.
- log contains `Plugin "request-audit" disabled`.
- worker requires force kill on restart.

Rollback action:

```bash
docker rm -f aiclient2api
docker rename <backup-container> aiclient2api
docker start aiclient2api
```

If rollback does not restore service, temporarily disable `request-audit` in `/root/ai_client_configs/plugins.json` and restart.

---

## Acceptance Criteria

- Default mode does not store raw prompt.
- Raw capture is disabled by default and scoped when enabled.
- `request-audit.html` can explain likely low-cache reasons.
- Diagnostic data may lag, but page shows freshness.
- Local focused tests pass.
- Local Docker smoke passes.
- Local real request smoke passes before remote deploy.
- Remote 94 deploy is done only after local commit.
- Remote `/api/health`, `/request-audit.html`, and `/api/usage` respond after deploy.
- Remote CPU remains stable under real traffic.

## Recommended Execution Mode

Use normal local task-by-task execution on `yyn/customized-branch`, with one commit per task group. Do not deploy to 47.77.196.94 until Task 9 passes locally and the working tree is clean.
