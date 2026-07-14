# Request Audit Observability

`request-audit` adds privacy-safe per-request JSONL audit events for future key/time-window investigations.

## Persisted Data

- request id, timestamp, Beijing date/hour
- potluck key hash and short display prefix, not the full key
- provider, account UUID, sanitized account display
- model, stream flag, outcome/status
- usage: prompt, cached, completion, reasoning, total, cache hit ratio
- approximate context breakdown: instructions, tools, conversation, attachments, metadata, cached input

## Query Examples

```text
/api/request-audit/summary?keyHash=sha256:<hash>&since=2026-06-23T17:05:00+08:00&until=2026-06-23T17:25:00+08:00
/api/request-audit/requests?keyHash=sha256:<hash>&since=2026-06-23T17:05:00+08:00&until=2026-06-23T17:25:00+08:00
```

The static report page is available at `request-audit.html`. It is a Chinese-first audit dashboard with:

- summary metrics for request count, prompt tokens, cached tokens, cache hit ratio, completion tokens, and total tokens
- approximate context section proportions similar to Cursor-style token category views
- per-request rows that can expand into a single-request token breakdown
- clear privacy copy that reminds operators raw prompts, full keys, tokens, cookies, and raw images are not persisted

## Accuracy Boundary

OpenAI-compatible usage fields are exact when returned by upstream. Context categories are estimates from request structure and are calibrated to real prompt tokens when available; they are intended to approximate Cursor-style context usage, not to reproduce Codex/Cursor internal source labels exactly.

## Privacy Boundary

Do not store raw prompts, raw images, full API keys, bearer tokens, OAuth tokens, cookies, browser auth state, or full emails. Audit files live under `configs/request-audit/` with a 24 hour default retention. Production deployments that need 35-day requestId replay for usage-stat recompute can set `REQUEST_AUDIT_RETENTION_HOURS=840`; see `docs/usage-ledger.md`.

`ai-monitor` is useful for short-lived protocol conversion debugging because it logs before/after request and response payloads through the normal logger. It currently uses `log-sanitizer`, so image/base64 payloads and oversized strings are summarized instead of being treated as a full raw prompt archive. If raw prompts are ever needed for a specific incident, implement that as a separate explicit danger-mode switch with short retention, isolated access, and a cleanup workflow rather than enabling it by default in `request-audit`.
