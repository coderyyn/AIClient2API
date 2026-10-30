# Node 24 security candidate

Scope: customized-branch, based on 99ff8a1. No production cutover or public ingress change.

The runtime and native build stages use Node 24 on Alpine 3.24. Resolve and record
base image digests for every candidate. System package upgrades must succeed;
never promote a stale cached layer solely because its parent image is unchanged.

Production npm vulnerabilities are addressed through compatible-major dependency
updates. deepmerge 4.3.1 is replaced with a licensed local adaptation that filters
unsafe keys from both target and source enumeration. Its seven compatibility and
prototype-safety cases cover recursive overrides, arrays and separate request copies.

The Go sidecar uses Go 1.26 with a checked-in go.sum and read-only module builds.
uTLS and network dependencies are upgraded after govulncheck identified reachable
issues. Chrome 120 is explicitly retained: it was HelloChrome_Auto in uTLS 1.6.7,
so the upgrade does not silently switch browser profiles. Local HTTP/1.1, HTTP/2,
streaming, certificate hostname rejection and HTTP CONNECT tests exercise the change.

GO-2026-5932 affects the unmaintained x/crypto/openpgp package within a required
module. The sidecar does not import it; source reachability scanning reports zero
affected symbols. Record this exception separately and verify the compiled binary.
Do not describe the entire module as vulnerability-free.

The token-cleanup interval is unreferenced so it cannot hold tests or a shutting-down
worker open; its five-minute schedule remains unchanged while the server is alive.

Validation: host Node 24 regressions, Linux Node 24 native SQLite and image tests,
production-image native smoke, production npm audit, Alpine security database,
Go source/binary scans, and an isolated four-worker/edge-auth candidate.
Candidates must not use production Redis state or make paid upstream calls.

The primary candidate binds 127.0.0.1:13001, has 2 CPUs/6 GiB memory/4 GiB Node heap,
drops NET_RAW and enables no-new-privileges. The edge candidate and Redis are private
and isolated. Snapshot histories and databases are excluded. Automatic upstream
health checks, usage refresh and prewarm are disabled in candidate-only configuration;
real provider entries are disabled for offline verification. Candidate mocks use
synthetic credentials. Production user IDs, file permissions and flags stay unchanged.

Publish a sanitized report with application commit, dependency versions, digests,
scan exceptions, runtime convergence and rollback steps. Stop candidates afterward.
Host SSH/kernel/Docker, Redis authentication and other services remain separate work.

The HTML escape helper now encodes quotes as well as angle brackets and ampersands.
The quota UI uses it in quoted title/value attributes; textContent-only escaping
was insufficient for those contexts. Behavior tests execute the real helper and
quota rendering/collection functions against synthetic attribute-breakout input.

Build the dedicated edge-auth image from the exact application image with
`docker/Dockerfile.edge-auth`; it inherits the same source and dependency layers
and supplies the edge server command and its own health probe.

Image scanning also covers the global npm CLI bundled with Node, independently of
application npm audit. Runtime npm is pinned to 11.21.1; its bundled Undici is
replaced with 6.29.1 and ip-address with 10.7.4 using exact registry tarballs.
These same-major corrections retain npm for the existing admin update mechanism.
Native smoke verifies both bundle versions and that npm itself starts. Scan the
merged final image rather than assuming an application-only audit covers the CLI.
