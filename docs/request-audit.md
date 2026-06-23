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

The static report page is available at `request-audit.html`.

## Accuracy Boundary

OpenAI-compatible usage fields are exact when returned by upstream. Context categories are estimates from request structure and are calibrated to real prompt tokens when available; they are intended to approximate Cursor-style context usage, not to reproduce Codex/Cursor internal source labels exactly.

## Privacy Boundary

Do not store raw prompts, raw images, full API keys, bearer tokens, OAuth tokens, cookies, browser auth state, or full emails. Audit files live under `configs/request-audit/` with a 24 hour default retention.
