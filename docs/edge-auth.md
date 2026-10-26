# Edge auth deployment

This repository contains a small, independent Node service for NGINX
`auth_request` integration. It is intentionally separate from the main API
workers so disabled or unknown API keys can be rejected before provider,
quota, proxy, and model-routing code runs.

## Phase-one behavior

- Active keys use a configurable high RPM ceiling (default `100000/minute`).
- Disabled, revoked, expired, unknown, malformed, and missing keys are rejected.
- IP RPM is measured in Redis, but enforcement is disabled by default.
- Redis failure uses a bounded local fail-open guard (`120/minute` by default).
- Existing Node provider/key concurrency controls remain authoritative.

## Edge admission leases

The edge service now acquires a Redis admission lease during `/authorize` and
returns it as `X-Edge-Lease-ID` plus `X-Edge-Lease-Mode`. NGINX has no callback
after the proxied request finishes, so the lease is bounded by
`EDGE_AUTH_LEASE_TTL_MS` (120s by default) and the API worker releases it when
the request completes. Waiting requests are queued and promoted in Redis.

The API worker only trusts these headers when `EDGE_ADMISSION_ENABLED=true`;
with `EDGE_ADMISSION_REQUIRED=true` a request that carries no valid lease is
rejected instead of falling back to in-process limits.

## Go-live checklist

1. Deploy the edge-auth image built from the same commit as the API image.
2. Replace the deployed `edge-auth-api-directives.conf` with the contents of
   `docker/nginx-edge-auth-api-location.conf` followed by exactly one of
   `docker/nginx-edge-auth-api-observe.conf` (dry-run) or
   `docker/nginx-edge-auth-api-enforce.conf` (rejecting), so the lease headers
   reach the upstream; without this step `edgeAdmissionMode=enforce` keys are
   enforced nowhere. The two add-ons are mutually exclusive because nginx allows
   `limit_req_dry_run` only once per context.
3. Point the API container at the edge-auth service with
   `EDGE_AUTH_INTERNAL_URL=http://edge-auth:18081`; the default
   `http://127.0.0.1:18081` resolves to the API container itself.
4. Set `EDGE_ADMISSION_ENABLED=true`, and only after confirming that leases
   actually arrive, `EDGE_ADMISSION_REQUIRED=true`, together with a deliberate
   `EDGE_AUTH_DEFAULT_KEY_CONCURRENCY`. Enabling `REQUIRED` before the Nginx
   snippet is live rejects every protected request.

## Local smoke test

```powershell
$env:REDIS_URL = 'redis://127.0.0.1:6379/0'
$env:EDGE_AUTH_POLICY_FILE = 'configs/api-potluck-keys.json'
node src/edge-auth/server.js
```

The service listens on `127.0.0.1:18081` by default. `GET /authorize` returns
204 for allowed requests, 401 for missing/unknown keys, and 403 for disabled
keys. Rate/admission rejections are internally encoded as 403 with
`X-Edge-Response-Status: 429`: `auth_request` only accepts 2xx/401/403.
The public NGINX boundary must restore these marked responses to HTTP 429.
`GET /health` returns 200.

## NGINX wiring

Include the `limit_req_zone` and `map` directives from
`docker/nginx-edge-auth.conf` inside the `http {}` block. Include the
complete `docker/nginx-edge-auth-location.conf` (both `/_edge_auth` and
`@edge_auth_denied`) inside each TLS/plain HTTP `server {}` block.
Add these directives to the API locations that should be protected:

Include `docker/nginx-edge-auth-api-location.conf` in each protected API
location. It captures the trusted subrequest's rate marker and redirects local
403s to the internal handler. Only the exact marker `429` becomes a public
429 JSON response; ordinary permission failures remain 403, and invalid keys
remain 401. Client-supplied markers are ignored. `proxy_intercept_errors off`
keeps model-service responses (including 403/429/503) unchanged, and the
internal rate marker is hidden from proxied responses.

Append exactly one of the observe/enforce IP add-ons after the API snippet.
NGINX's own IP rejections remain 429. The restored edge response is:

```json
{"error":{"type":"rate_limit_error","code":"rate_limited","message":"Too many requests. Please retry later."}}
```

No fixed `Retry-After` is added: the internal protocol does not provide a
reliable recovery time. Clients should use bounded backoff with jitter.

`limit_req_dry_run on` means the IP rule records would-be rejections without
blocking. Remove `limit_req_dry_run on` only after selecting an IP policy.

The subrequest forwards Bearer, `x-api-key`, `x-goog-api-key`, and the current
`?key=`/`?api_key=` query values. It also forwards the trusted NGINX
`$remote_addr` as `X-Edge-Client-IP`; do not trust a client-supplied forwarded
IP header in edge-auth.

## Error-semantics rollout and rollback

After explicit production authorization, back up the active snippets and
replace the **server-level location snippet and API directives together**.
Apply the same wiring to all protected locations on domain and public-port
ingresses, including every HTTP/TLS server. Replacing API directives alone
fails `nginx -t` because the named handler would be missing. Check for local
`error_page` overrides when reviewing the effective configuration.
Run `nginx -t` before a graceful reload; if validation fails, restore the
backups without reloading. Retain the backups for rollback and validate again
before reloading a restored configuration. This correction requires no
edge-auth restart or changes to key status, limits or Redis data.

The separate application correction preserves capacity rejections through
provider/model fallback: successful fallback still wins; after all permitted
attempts fail, quota errors take priority over concurrency errors, then other
429s. Capacity failures use HTTP 429 / `PROVIDER_CONCURRENCY_EXHAUSTED` rather
than turning into `PROVIDER_CREDENTIALS_UNAVAILABLE` 503. Truly unavailable
credentials still return 503, and non-429 exceptions propagate unchanged.
Deploy that application change through the normal controlled release and
retain its prior image independently of the NGINX rollback.

Observe entrance status counts separately from application audit outcomes:
entrance-rejected requests never enter the application's request audit.
Correct classification alone does not add capacity or improve success rates.

## Isolated regression tests

```powershell
npx.cmd jest --runInBand tests/provider-pool-fallback-error-semantics.test.js tests/edge-auth-service.test.js tests/service-manager-provider-error-semantics.test.js
```

The real NGINX test uses only synthetic credentials and local mock services.
It requires Docker and an already available NGINX image; it never pulls images
or contacts model APIs. Select a locally available image if needed:

```powershell
$env:EDGE_AUTH_NGINX_TEST_IMAGE = 'nginx:stable-alpine'
node tests/edge-auth-nginx.integration.mjs
```

The runner executes `nginx -t`, checks Codex/Gemini/generic API locations,
tests genuine 401/403, encoded 429, unchanged upstream errors, IP limits,
marker spoofing and internal-location protection, then removes its temporary
container and configuration directory. It binds temporary mock listeners on
host ports reachable from Docker; no production services are used.

## Compose

`docker/docker-compose.edge-auth.yml` is an override-style service definition.
Run it together with the existing compose file after reviewing the image build
and volume paths. It does not modify the active production container or NGINX.
