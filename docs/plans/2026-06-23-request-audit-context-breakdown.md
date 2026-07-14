# Request Audit Context Breakdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add privacy-safe per-request audit logs and approximate Cursor-style context usage categories for future key/time-window investigations.

**Architecture:** Add a built-in `request-audit` plugin that observes existing request/response hooks, estimates request section token weights before/after conversion, merges real upstream usage, and persists one JSONL event per finalized request. Keep existing `model-usage-stats` and `api-potluck` aggregate stores as-is; this feature adds queryable detail without storing raw prompts, raw images, full request bodies, credentials, or cookies.

**Tech Stack:** Node.js ESM, Jest, existing plugin manager hooks, existing `src/utils/token-utils.js`, JSONL files under `configs/request-audit/`.

**Project Progress Doc:** `.plans/summary.md`
**Test Overview Doc:** `tests/` Jest suite

---

## Scope

Build this on branch `yyn/customized-branch` from the repository root.

In scope:

- Persist finalized request audit events for at least 24 hours by default.
- Support querying by potluck key hash/prefix, request id, provider/account/model, status, and Beijing time window.
- Record OpenAI/compatible usage fields: prompt, cached, completion, reasoning, total.
- Add approximate context categories similar to Cursor: system/instructions, tool definitions, conversation, attachments, request metadata, cached input, output, reasoning.
- Calibrate estimated prompt-side categories against real `promptTokens` when upstream usage exists.
- Avoid raw prompt, raw image, full request body, full API key, bearer token, OAuth token, cookie, and browser auth state persistence.

Out of scope:

- Exact Codex client internal categories such as true `Rules`, `Skills`, `MCP`, or `Subagent definitions`.
- Full UI redesign.
- Reading hidden browser profiles, cookies, localStorage, or token caches.
- Long-term request retention beyond the configured audit window.

## Data Contract

Each finalized request writes one JSON object per line:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-06-23T09:25:00.000Z",
  "beijingDate": "2026-06-23",
  "beijingHour": "17",
  "requestId": "107.172.111.58:481c2247",
  "request": {
    "method": "POST",
    "path": "/v1/responses",
    "fromProvider": "openai-responses",
    "toProvider": "openai-codex-oauth",
    "model": "gpt-5.5",
    "stream": true
  },
  "potluckKey": {
    "present": true,
    "hash": "sha256:16hex",
    "prefix": "maki_4734b4...",
    "name": "optional-key-name"
  },
  "account": {
    "providerUuid": "8fb06b25-0248-4143-bf8a-af7827cad678",
    "providerNameHash": "sha256:16hex",
    "providerNameDisplay": "redacted-email:c31f1c38"
  },
  "status": {
    "outcome": "success",
    "httpStatus": 200,
    "errorClass": null,
    "retryCount": 0,
    "cooldownApplied": false
  },
  "usage": {
    "promptTokens": 739892,
    "cachedTokens": 71552,
    "completionTokens": 5655,
    "reasoningTokens": 2022,
    "totalTokens": 743525,
    "cacheHitRatio": 0.0967
  },
  "contextBreakdown": {
    "estimationMethod": "anthropic-tokenizer-ratio-calibrated",
    "sections": [
      {"id": "instructions", "label": "System / Instructions", "estimatedTokens": 12000, "calibratedTokens": 11800, "percentOfPrompt": 0.0159},
      {"id": "tools", "label": "Tool definitions", "estimatedTokens": 9500, "calibratedTokens": 9300, "percentOfPrompt": 0.0126},
      {"id": "conversation", "label": "Conversation", "estimatedTokens": 690000, "calibratedTokens": 680000, "percentOfPrompt": 0.9191},
      {"id": "attachments", "label": "Attachments / Images", "estimatedTokens": 0, "calibratedTokens": 0, "percentOfPrompt": 0},
      {"id": "metadata", "label": "Request metadata", "estimatedTokens": 2000, "calibratedTokens": 1970, "percentOfPrompt": 0.0027},
      {"id": "cached_input", "label": "Cached input", "tokens": 71552, "percentOfPrompt": 0.0967}
    ]
  }
}
```

Notes:

- `prefix` is a non-secret display prefix only; use `hash` for exact filtering.
- `providerNameDisplay` must use a sanitizer, never raw email or full user identifier.
- `contextBreakdown.sections[].estimatedTokens` is local estimate; `calibratedTokens` is estimate scaled to real `usage.promptTokens`.
- `cached_input`, `output`, and `reasoning` come from response usage, not request estimation.

## Task 1: Context Breakdown Estimator

**Files:**

- Create: `src/plugins/request-audit/context-breakdown.js`
- Test: `tests/request-audit-context-breakdown.test.js`

**Step 1: Write failing tests**

Add tests for OpenAI Chat, OpenAI Responses, Claude Messages, and image virtual request bodies.

```js
import { buildContextBreakdown } from '../src/plugins/request-audit/context-breakdown.js';

test('classifies OpenAI chat system tools and conversation without raw text', () => {
  const result = buildContextBreakdown({
    originalRequestBody: {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'policy text' },
        { role: 'developer', content: 'rule text' },
        { role: 'user', content: 'hello' }
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    },
    usage: { promptTokens: 1000, cachedTokens: 120 }
  });

  expect(result.sections.map(s => s.id)).toEqual(expect.arrayContaining([
    'instructions',
    'tools',
    'conversation',
    'cached_input'
  ]));
  expect(JSON.stringify(result)).not.toContain('policy text');
  expect(result.sections.find(s => s.id === 'cached_input').tokens).toBe(120);
});
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-context-breakdown.test.js --runInBand
```

Expected: FAIL because `context-breakdown.js` does not exist.

**Step 3: Implement minimal estimator**

Implement helpers:

- `buildContextBreakdown({ originalRequestBody, processedRequestBody, usage })`
- `classifyOpenAIChat(body)`
- `classifyOpenAIResponses(body)`
- `classifyClaudeMessages(body)`
- `classifyGeminiContent(body)`
- `calibrateSections(sections, usage.promptTokens)`

Use existing `countTextTokens`, `processContent`, and image/document heuristics from `src/utils/token-utils.js`.

Classification rules:

- `instructions`: OpenAI `system`/`developer` messages, Responses `instructions`, Claude `system`, Gemini `systemInstruction`.
- `tools`: `tools`, `tool_choice`, Gemini `functionDeclarations`, Claude `tools`.
- `conversation`: user/assistant/tool messages or Responses `input` items.
- `attachments`: image/document/file/base64 parts counted as estimates only; never store payload data.
- `metadata`: model params and small request fields such as `reasoning`, `temperature`, `max_tokens`, `max_output_tokens`.
- `cached_input`: real `usage.cachedTokens`.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-context-breakdown.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/context-breakdown.js tests/request-audit-context-breakdown.test.js
git commit -m "feat: add request context breakdown estimator"
```

## Task 2: JSONL Audit Store With Retention

**Files:**

- Create: `src/plugins/request-audit/audit-store.js`
- Test: `tests/request-audit-store.test.js`

**Step 1: Write failing tests**

Cover append, query by time window, query by key hash, and cleanup retention.

```js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RequestAuditStore } from '../src/plugins/request-audit/audit-store.js';

test('persists and queries request audit jsonl by key hash and Beijing time window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-'));
  const store = new RequestAuditStore({ dir, retentionHours: 24 });

  await store.append({
    schemaVersion: 1,
    timestamp: '2026-06-23T09:10:00.000Z',
    beijingDate: '2026-06-23',
    beijingHour: '17',
    requestId: 'req-1',
    potluckKey: { hash: 'abc123' },
    request: { model: 'gpt-5.5' },
    usage: { promptTokens: 1000, cachedTokens: 100 }
  });

  const rows = await store.query({
    keyHash: 'abc123',
    since: '2026-06-23T17:05:00+08:00',
    until: '2026-06-23T17:25:00+08:00'
  });

  expect(rows).toHaveLength(1);
  expect(rows[0].requestId).toBe('req-1');
});
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-store.test.js --runInBand
```

Expected: FAIL because `audit-store.js` does not exist.

**Step 3: Implement JSONL store**

Implement:

- `new RequestAuditStore({ dir, retentionHours, maxFileBytes })`
- `append(event)`
- `query({ keyHash, keyPrefix, requestId, since, until, model, provider, outcome })`
- `cleanup(now = new Date())`

Defaults:

- `dir`: `path.join(process.cwd(), 'configs', 'request-audit')`
- `retentionHours`: `24`
- `maxFileBytes`: `100 * 1024 * 1024`
- file name: `audit-YYYY-MM-DD.jsonl`
- file mode: `0o600`

Implementation constraints:

- Append one compact JSON line per finalized request.
- Ignore corrupted JSONL lines during query and log a warning.
- Query only files whose date could overlap the requested time window.
- Cleanup deletes only files matching `audit-YYYY-MM-DD.jsonl` inside the configured audit directory.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-store.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/audit-store.js tests/request-audit-store.test.js
git commit -m "feat: add request audit jsonl store"
```

## Task 3: Audit Event Builder And Sanitization

**Files:**

- Create: `src/plugins/request-audit/audit-event.js`
- Test: `tests/request-audit-event.test.js`

**Step 1: Write failing tests**

Test that API keys, emails, prompts, and base64 images do not appear in serialized events.

```js
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';

test('builds sanitized audit event with key hash and no raw prompt', () => {
  const event = buildRequestAuditEvent({
    requestId: 'req-1',
    potluckApiKey: 'maki_4734b4e5fe29dc2af36d8296a46f3462',
    providerName: 'user@example.com',
    originalRequestBody: {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'secret prompt text' }]
    },
    usage: { promptTokens: 1000, cachedTokens: 100, totalTokens: 1100 }
  });

  const serialized = JSON.stringify(event);
  expect(event.potluckKey.hash).toMatch(/^sha256:/);
  expect(event.potluckKey.prefix).toBe('maki_4734b4...');
  expect(serialized).not.toContain('maki_4734b4e5fe29dc2af36d8296a46f3462');
  expect(serialized).not.toContain('secret prompt text');
  expect(serialized).not.toContain('user@example.com');
});
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-event.test.js --runInBand
```

Expected: FAIL because `audit-event.js` does not exist.

**Step 3: Implement event builder**

Implement:

- `hashSecret(value, length = 16)`
- `maskPotluckKey(key)`
- `sanitizeProviderName(name)`
- `normalizeUsage(usage)`
- `buildRequestAuditEvent(hookContext)`

Event builder inputs should match existing hook context:

- `config._monitorRequestId`
- `config.originalRequestBody`
- `config.processedRequestBody`
- `config.potluckApiKey`
- `config.fromProvider`
- `config.toProvider`
- `config.providerUuid`
- `config.providerName`
- `config.model`
- `config.isStream`

Use `buildContextBreakdown()` from Task 1.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-event.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/audit-event.js tests/request-audit-event.test.js
git commit -m "feat: add sanitized request audit events"
```

## Task 4: Built-In Request Audit Plugin

**Files:**

- Create: `src/plugins/request-audit/index.js`
- Modify: `src/core/plugin-manager.js`
- Test: `tests/request-audit-plugin.test.js`

**Step 1: Write failing tests**

Test hook lifecycle:

- `onUnaryResponse` stores usage by request id.
- `onStreamChunk` merges usage by request id.
- `onContentGenerated` writes exactly one audit JSONL row.
- Plugin is enabled by default or explicitly configurable.

```js
test('request-audit writes finalized event with merged usage', async () => {
  const plugin = (await import('../src/plugins/request-audit/index.js')).default;
  const auditStore = { append: jest.fn(), cleanup: jest.fn() };
  await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

  await plugin.hooks.onUnaryResponse({
    requestId: 'req-1',
    nativeResponse: { usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 100 } } },
    model: 'gpt-5.5'
  });

  await plugin.hooks.onContentGenerated({
    _monitorRequestId: 'req-1',
    potluckApiKey: 'maki_secret_key',
    originalRequestBody: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] },
    model: 'gpt-5.5',
    toProvider: 'openai-codex-oauth'
  });

  expect(auditStore.append).toHaveBeenCalledTimes(1);
});
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-plugin.test.js --runInBand
```

Expected: FAIL because plugin does not exist.

**Step 3: Implement plugin**

Plugin metadata:

- `name: 'request-audit'`
- `type: 'middleware'`
- `_builtin: true`
- `_priority: 8990`
- route path: `/api/request-audit`

Config:

- `REQUEST_AUDIT_ENABLED`: default `true`
- `REQUEST_AUDIT_RETENTION_HOURS`: default `24`
- `REQUEST_AUDIT_DIR`: default `configs/request-audit`
- `REQUEST_AUDIT_MAX_FILE_BYTES`: default `100MB`

Hook behavior:

- Keep `pendingUsage` map by request id.
- Merge usage from unary and stream chunks using the same usage normalization semantics as `model-usage-stats`.
- On finalize, build sanitized event and append to store.
- Delete pending state after finalize.
- Cleanup stale pending state older than 10 minutes.
- Never throw from hooks; log warning and do not affect upstream request.

Plugin manager change:

- Remove `request-audit` from any default disabled list if present.
- Keep `model-usage-stats` behavior unchanged.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-plugin.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/index.js src/core/plugin-manager.js tests/request-audit-plugin.test.js
git commit -m "feat: add request audit plugin"
```

## Task 5: Query API And Summary Aggregation

**Files:**

- Create: `src/plugins/request-audit/api-routes.js`
- Modify: `src/plugins/request-audit/index.js`
- Test: `tests/request-audit-api.test.js`

**Step 1: Write failing tests**

Test:

- `GET /api/request-audit/requests?keyHash=...&since=...&until=...`
- `GET /api/request-audit/summary?keyHash=...&since=...&until=...`
- Summary returns request count, usage totals, cache hit ratio, model/account breakdown, and context section totals.

Expected summary shape:

```json
{
  "success": true,
  "data": {
    "window": {
      "since": "2026-06-23T17:05:00+08:00",
      "until": "2026-06-23T17:25:00+08:00"
    },
    "summary": {
      "requestCount": 5,
      "promptTokens": 739892,
      "cachedTokens": 71552,
      "completionTokens": 5655,
      "reasoningTokens": 2022,
      "totalTokens": 743525,
      "cacheHitRatio": 0.0967
    },
    "models": {
      "gpt-5.5": {
        "requestCount": 5,
        "promptTokens": 739892,
        "cachedTokens": 71552,
        "cacheHitRatio": 0.0967
      }
    },
    "contextSections": {
      "conversation": {
        "tokens": 680000,
        "percentOfPrompt": 0.9191
      }
    }
  }
}
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-api.test.js --runInBand
```

Expected: FAIL because API routes do not exist.

**Step 3: Implement route handlers**

Implement:

- `handleRequestAuditRoutes(req, res, requestUrl, config)`
- `buildAuditSummary(events)`
- `parseAuditQuery(requestUrl)`

Endpoints:

- `GET /api/request-audit/requests`
- `GET /api/request-audit/summary`
- `GET /api/request-audit/request/:requestId` if plugin route matching supports it; otherwise use `?requestId=...`.

Safety:

- Return masked key display only.
- Do not expose full raw event if it contains future unknown fields that look secret-like.
- Cap `limit` default `200`, max `2000`.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-api.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/request-audit/api-routes.js src/plugins/request-audit/index.js tests/request-audit-api.test.js
git commit -m "feat: expose request audit query api"
```

## Task 6: Potluck Admin Linkage

**Files:**

- Modify: `src/plugins/api-potluck/api-routes.js`
- Modify: `static/potluck.html` or existing Potluck UI module if the project uses one
- Test: `tests/request-audit-potluck-link.test.js`

**Step 1: Write failing tests**

Test that key detail response includes audit query metadata, not the raw key:

```js
expect(key.audit).toMatchObject({
  keyHash: expect.stringMatching(/^sha256:/),
  queryPath: expect.stringContaining('/api/request-audit/summary')
});
expect(JSON.stringify(key.audit)).not.toContain('maki_secret_key');
```

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-potluck-link.test.js --runInBand
```

Expected: FAIL until potluck admin response includes audit query metadata.

**Step 3: Implement linkage**

Add a derived `audit` field to key list/detail output:

- `keyHash`
- `queryPath`
- `defaultWindow`: last 20 minutes or current Beijing hour

UI minimal addition:

- Add "Audit" action beside each key.
- It opens the summary endpoint for that key hash and a selectable time window.
- Keep UI basic; full charting can wait.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-potluck-link.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/plugins/api-potluck/api-routes.js static/potluck.html tests/request-audit-potluck-link.test.js
git commit -m "feat: link potluck keys to request audit"
```

## Task 7: Optional Report HTML Similar To Cursor Panel

**Files:**

- Create: `static/request-audit.html`
- Create or modify: `static/components/section-request-audit.css`
- Modify: `src/plugins/request-audit/index.js`
- Test: `tests/request-audit-ui-source.test.js`

**Step 1: Write failing source tests**

Assert that the static page references:

- `/api/request-audit/summary`
- stacked context usage bar
- rows for `instructions`, `tools`, `conversation`, `attachments`, `cached_input`, `output`, `reasoning`

**Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- tests/request-audit-ui-source.test.js --runInBand
```

Expected: FAIL because the page does not exist.

**Step 3: Implement simple static report**

UI requirements:

- Header: key display, time window, total tokens, cache hit ratio.
- Stacked bar similar to Cursor: each section gets color, token count, percent.
- Detail table: request id, time, model, account display, prompt, cached, completion, reasoning, total, cache rate.
- No raw prompts.
- Mobile responsive.

Static plugin update:

- Add `staticPaths: ['request-audit.html']` in `src/plugins/request-audit/index.js`.

**Step 4: Run test to verify it passes**

Run:

```powershell
npm test -- tests/request-audit-ui-source.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add static/request-audit.html static/components/section-request-audit.css src/plugins/request-audit/index.js tests/request-audit-ui-source.test.js
git commit -m "feat: add request audit report page"
```

## Task 8: End-To-End Verification

**Files:**

- Modify: `README-ZH.md` or `docs/` observability doc if present
- Optional create: `docs/request-audit.md`

**Step 1: Run focused tests**

```powershell
npm test -- tests/request-audit-context-breakdown.test.js tests/request-audit-store.test.js tests/request-audit-event.test.js tests/request-audit-plugin.test.js tests/request-audit-api.test.js --runInBand
```

Expected: PASS.

**Step 2: Run adjacent regression tests**

```powershell
npm test -- tests/model-usage-account-stats.test.js tests/api-potluck-key-usage-summary.test.js tests/logger-retention.test.js --runInBand
```

Expected: PASS.

**Step 3: Run full Jest suite if practical**

```powershell
npm test -- --runInBand
```

Expected: PASS. If full suite is too slow or has unrelated failures, record exact failures in the implementation handoff.

**Step 4: Local smoke**

Start app in standalone mode:

```powershell
npm run start:standalone
```

Send a small request through a potluck key in a separate terminal, then query:

```powershell
Invoke-RestMethod "http://127.0.0.1:<port>/api/request-audit/summary?keyHash=<hash>&since=<iso>&until=<iso>"
```

Expected:

- One request appears.
- Summary includes cache ratio fields if upstream response has usage.
- `configs/request-audit/audit-YYYY-MM-DD.jsonl` exists.
- JSONL contains no raw prompt, full key, bearer token, cookie, base64 image data, or raw email address.

**Step 5: Docker smoke**

Build the customized image using the existing Docker notes in `AGENTS.md`, then run with:

- request-audit plugin enabled
- `REQUEST_AUDIT_RETENTION_HOURS=24`
- mounted `configs/` volume

Expected:

- App starts.
- Audit file persists under container `/app/configs/request-audit/`.
- `GET /api/request-audit/summary` can answer a 20-minute window after test traffic.

**Step 6: Documentation**

Document:

- What fields are persisted.
- How to query a key/time window.
- Difference between exact OpenAI usage and approximate context categories.
- Privacy boundary: no raw prompt/key/token/cookie.
- Retention defaults and config knobs.

**Step 7: Commit**

```powershell
git add README-ZH.md docs/request-audit.md
git commit -m "docs: document request audit observability"
```

## Rollout Plan

1. Merge local commits on `yyn/customized-branch`.
2. Build Docker image with a new tag.
3. Deploy to staging or the target server during low traffic.
4. Generate 2-3 known requests with a test potluck key.
5. Query last 20 minutes and verify:
   - request count matches logs,
   - usage matches upstream response usage,
   - context sections sum near real prompt tokens after calibration,
   - raw prompt/key/email/base64 data is absent.
6. Keep 24h retention initially.
7. After one day, confirm old files are cleaned and yesterday's recent window is still queryable until retention cutoff.

## Risks And Mitigations

- **Risk:** Token category estimate differs from true Codex/Cursor categories.
  **Mitigation:** Label as `estimated` and show `estimationMethod`; use real prompt tokens for calibration.
- **Risk:** JSONL grows too quickly.
  **Mitigation:** Default 24h retention, max file bytes, compact event schema, no raw bodies.
- **Risk:** Sensitive data leaks through provider/account labels.
  **Mitigation:** hash and sanitize all labels before writing; add tests for emails, full keys, bearer tokens, cookies, base64 images.
- **Risk:** Hook failures affect model traffic.
  **Mitigation:** all plugin hook work catches errors and never throws into request flow.
- **Risk:** Retry path creates duplicate rows.
  **Mitigation:** one final event per `_monitorRequestId`; include `retryCount` if available later.

## Handoff

Plan complete and saved to `docs/plans/2026-06-23-request-audit-context-breakdown.md`.

Execution options:

1. Subagent-Driven in this session: implement task-by-task with review after each task.
2. Parallel Session: open a new Codex session in this repo and execute this plan with `executing-plans`.
