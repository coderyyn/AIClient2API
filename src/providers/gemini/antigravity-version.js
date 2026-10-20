/**
 * Antigravity client identity.
 *
 * The default stays on the legacy `antigravity/2.9.1` user agent. A Hub-style
 * user agent (`antigravity/hub/<ver>`, as CLIProxyAPI sends) was tried on
 * 2026-10-20 and reverted: Google started returning 403 "disabled ... for
 * violation of Terms of Service" for a growing set of accounts right after it
 * went live. Cause unconfirmed; keep this value stable and use
 * ANTIGRAVITY_USER_AGENT to override it deliberately.
 */
export const ANTIGRAVITY_DEFAULT_USER_AGENT = 'antigravity/2.9.1 darwin/arm64';

/**
 * Extract the semantic version from any Antigravity UA shape:
 * `antigravity/2.9.1 ...`, `antigravity/hub/2.23.0 ...`, `antigravity/cli/1.3.1 (...)`.
 */
export function parseAntigravityUserAgentVersion(userAgent) {
    return /^antigravity\/(?:[a-z]+\/)?(\d+\.\d+\.\d+)/i.exec(String(userAgent || ''))?.[1] || '';
}
