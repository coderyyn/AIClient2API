# Mainland client-key policy

Optional, independently updated Alibaba Cloud exceptions are documented in
[Alibaba Cloud allowlist](alibaba-cloud-allowlist.md); they never modify CN data.

Client `maki_` keys on model and own-usage routes are admitted only when the verified
public source IP belongs to the compiled CN ranges. Key values are not rotated.
Management tokens, management IP allowlists, static resources and minimal health
probes remain independent. Country admission never substitutes for key/quota checks.

Set `MAINLAND_CLIENT_KEYS_ONLY_REQUIRED=true` and pin `MAINLAND_COUNTRY_FILE` to a
read-only data mount. Also record `MAINLAND_CLIENT_KEYS_ONLY=true` and
`REQUEST_AUDIT_NETWORK_METADATA_ENABLED=true` in protected production configuration.
Mandatory country admission forces network auditing on, even if a runtime UI update
tries to disable the optional audit flag.

Use DB-IP Country Lite monthly CSV data, under CC BY 4.0, with attribution to
https://db-ip.com. No online lookup is made per request. The compiler records the
compressed source SHA-256, month, generation time, compiled hash and IPv4/IPv6 counts.

Run the updater explicitly each month, in the application image with a writable
operator-only data mount (services mount the directory read-only):

```
docker run --rm --network host --cap-drop ALL --security-opt no-new-privileges --mount type=bind,src=/root/aiclient-country-data,dst=/data --entrypoint node aiclient2api:mainland-648cd1d scripts/ops/update-mainland-ranges.mjs --month YYYY-MM --output /data/cn-ip-ranges.json --runtime-url http://127.0.0.1:13000/runtime/health --edge-health-url http://127.0.0.1:18081/health
```

When verifying host loopback endpoints from a temporary updater container, use its
host network. Do not install a host timer as part of this release. Failed downloads,
validation or downgrades leave the current file intact. Atomic replacement is followed
by worker/edge version convergence verification. Invalid reloads retain the last
valid in-memory data; cold startup without valid data rejects client keys with 503.
An IP absent from CN data, private, invalid or unverifiable is rejected with 403.

The runtime proxy resolves the actual peer using an exact trusted-proxy list. It
replaces client-supplied internal headers and signs network metadata with a fresh
per-master HMAC key passed only to its loopback workers. Workers reject forged or
missing envelopes rather than trusting forwarded public headers merely because
the TCP peer became loopback. Include the verified Docker host gateway hosting
Nginx in the production trust list; never trust an entire private address range.

edge-auth rejects foreign/unknown client-key sources before acquiring leases.
Nginx forwards denied admission requests, without bodies, to the application with
a trusted deny-only status for audit. The application honors it before provider or
quota dispatch, even when its own country lookup would permit the IP. Normal proxy
locations clear that status. Deploy the new denial locations/directives only during
maintenance with the matching application; old applications do not honor the marker.

Audit events keep key hashes, request IDs, source/peer IPs and country decisions,
including refusal and unavailability. Enable the network metadata flag end-to-end;
do not backfill old null IPs. No full keys or request bodies are added to audit.
The new ingress log format excludes query strings and redacts key-management paths.
Backups and shared allowlist files are not replaced with stale snapshots.
