# Management access boundary

Production ingress admits public model routes, GET user-owned usage, the user
usage page and its base stylesheet, and minimal health probes. All other routes
require the entry's existing management IP allowlist. This is independent of
administrator authentication and applies to reads, writes, aliases and new
plugin paths. Keep application ports private and trust forwarded client IP only
from explicitly configured reverse proxies.

`scripts/ops/prepare-management-ingress.py --output DIRECTORY` renders proposed
configuration from the live per-entry lists without installing or merging them.
A missing public port configuration stays absent. Validate the proposed complete
Nginx configuration and both permitted and denied request paths before reload.
The existing internal `/_edge_auth` location remains internal.

Workers authenticate management APIs before plugin dispatch. Login and public
business routes retain their own authentication. The standalone master listener
binds loopback. Runtime details remain subject to ingress admission; internal
loopback probes continue to work.

Online plugin installation is disabled by default. Both HTTP handlers and the
installer reject before reading uploaded bodies, downloading or extracting
archives. Only the deployment environment can set `PLUGIN_INSTALL_ENABLED=true`;
production must leave it unset/false. Plugins should ship in reviewed images.
The plugin-list response adds `installationEnabled` for UI capability display.

Regression checks: management access policy, handler ordering, installer disable,
Nginx rendering, existing provider pool and runtime suites. Release only reviewed
commits through the existing candidate and single-writer maintenance workflow.
