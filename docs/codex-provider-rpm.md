# Codex provider RPM

## Behavior

`openai-codex-oauth` provider configuration accepts `rpmLimit`, a non-negative
safe integer. Missing or `0` disables the limiter. Other provider types do not
show this field. The editor and create form use the existing provider API and
revisioned worker synchronization. Credential manifest hashes include the limit.

The limit covers actual model-send attempts in a rolling 60-second window,
including stream/unary calls, same-account overload/rate-limit/compatibility
retries, and model-based health checks/prewarming. Usage/catalog/OAuth calls are
excluded. Attempts consume a permit before sending and never refund it. This
does not impose a per-second burst limit, and does not guarantee zero upstream
429s or increase upstream account quota.

All client Keys, models and workers share the Redis counter for one
`providerType + UUID`. Duplicate provider entries for the same upstream account
do **not** share a counter. Check account uniqueness before enabling production.

Redis Lua uses server time and atomically expires old entries, checks capacity
and records a unique attempt. Candidate checks do not consume permits; the send
gate remains authoritative after selection races. Window keys expire after 120
seconds of inactivity. Small recovery metadata keys persist independently of
concurrency leases; do not delete these keys during ordinary lease recovery.
Changing limits preserves the current window, including when lowering a limit.

Runtime synchronization initializes an independent 60-second recovery guard on
the first startup of a Redis namespace. Existing guards are not reset by worker
restarts. Missing namespace data or loss of a recent window triggers a full
60-second guard. A guard refusal is local 429; unavailable Redis is local 503,
never per-worker fallback or unlimited admission. A standalone process without
Redis can run with the limit disabled; enabling it fails closed.

## Routing and observability

Exhausted candidates are skipped. A send-time refusal releases its provider
lease and tries another candidate within the existing route. Fixed/restricted
Key rules remain in force. No new queue is introduced, and RPM-rejected UUIDs
stay excluded for the remainder of that request. No switch occurs after visible
stream output. Local refusals do not trigger upstream cooldown or account health
penalties; health checks blocked locally report `skipped`.

Client responses use `PROVIDER_RPM_LIMIT_EXCEEDED`, HTTP 429 and integer-second
`Retry-After`. Responses contain no account email. The provider list/detail API
adds a read-only `rpm` object with `limit`, `used`, `allowed`, `retryAfterMs`,
`nextAvailableAt` (Unix milliseconds), and `recovering`; failures expose an error
instead of inventing a usage count. This runtime object is hidden from editable
provider fields.

Request audit includes `providerRpmRejections` with hashed provider UUID, phase
(`selection` or `send`), code, limit, usage and retry delay. These entries are not
upstream attempts. Count final request outcomes separately from candidate
rejections and upstream attempts. An eventual successful switch can have local
rejection entries and still be a successful business request.

## Verification

The focused Jest tests include real Redis Lua concurrency/window/recovery tests,
mock upstream stream/unary retries, routing restrictions, HTTP errors, provider
API validation/status, configuration synchronization and health-check skipping.

For the real Redis tests set `RPM_TEST_REDIS_PORT` to an **isolated local test
Redis**. The suite uses unique `rpm-test-*` namespaces and deletes only those
namespaces. Never point it at production. Example PowerShell:

```powershell
$env:RPM_TEST_REDIS_PORT = '16389'
npx.cmd --no-install jest --runInBand tests/provider-rpm-redis.integration.test.js
```

## Production release gate

Implementation does not automatically change production configuration. Obtain
the separate production authorization required by the approved plan and project
AGENTS.md before deploying or changing the account limit.

1. Record current app/edge image revisions, provider config revision and worker
   manifest hashes; back up the configuration and matching rollback images.
2. Verify `donerzafer10@gmail.com` maps to exactly one active Codex provider UUID;
   inspect other representations of the account as well. Stop account activation
   if duplicate entries could bypass its intended aggregate limit.
3. Deploy paired app/edge images using the repository's release procedure, with
   RPM disabled. Wait for healthy topology, complete config convergence and at
   least 60 seconds after RPM guard initialization.
4. Set only the verified provider's `rpmLimit` to `180` through the management
   API/editor. Confirm the revised manifest/config reaches every worker and the
   provider status shows `limit: 180` with recovery complete.
5. Observe at least 30 minutes without paid synthetic model probes. Compare final
   successful requests/minute, actual upstream attempt counts in rolling windows,
   upstream 429s, local RPM 429s, client aborts and latency. Verify no rolling
   window exceeds 180 admitted attempts and no routing escape/retry loop occurs.
   Finalized-request audit can lag in-flight attempts, so reconcile after drain.
6. To disable, set `rpmLimit: 0` and verify worker convergence. For a code rollback,
   restore the matched app/edge images and backed-up provider configuration. Do
   not clear Redis counters to make an account appear available.

Current delivery is local implementation and verification; production activation
and the 30-minute observation remain release actions.
