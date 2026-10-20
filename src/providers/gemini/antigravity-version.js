import axios from 'axios';
import logger from '../../utils/logger.js';

/**
 * Antigravity client identity, aligned with CLIProxyAPI's
 * internal/misc/antigravity_version.go.
 *
 * Cloud Code gates on the client family plus version: a bare `antigravity/x.y.z`
 * or a Hub version below 2.23.0 sees a shorter model list and cannot reach the
 * newest models. The fallback is therefore also the floor.
 */
export const ANTIGRAVITY_FALLBACK_VERSION = '2.23.0';
export const ANTIGRAVITY_HUB_PLATFORM = 'darwin/arm64';
export const ANTIGRAVITY_VERSION_MANIFEST_URL =
    'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml';

const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_REFRESH_INTERVAL_MS = VERSION_CACHE_TTL_MS / 2;
const VERSION_FETCH_TIMEOUT_MS = 10000;
const VERSION_MANIFEST_MAX_BYTES = 4096;
const STRICT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

let cachedVersion = null;
let cachedAt = 0;
let refreshTimer = null;

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

export function parseAntigravityManifestVersion(manifestText) {
    const match = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(String(manifestText || ''));
    const version = match?.[1] || '';
    return STRICT_VERSION_PATTERN.test(version) ? version : null;
}

/**
 * Extract the semantic version from any Antigravity UA shape:
 * `antigravity/2.9.1 ...`, `antigravity/hub/2.23.0 ...`, `antigravity/cli/1.3.1 (...)`.
 */
export function parseAntigravityUserAgentVersion(userAgent) {
    return /^antigravity\/(?:[a-z]+\/)?(\d+\.\d+\.\d+)/i.exec(String(userAgent || ''))?.[1] || '';
}

export function getAntigravityLatestVersion(now = Date.now()) {
    if (
        cachedVersion
        && now - cachedAt < VERSION_CACHE_TTL_MS
        && compareVersions(cachedVersion, ANTIGRAVITY_FALLBACK_VERSION) >= 0
    ) {
        return cachedVersion;
    }
    return ANTIGRAVITY_FALLBACK_VERSION;
}

export function getAntigravityUserAgent() {
    return `antigravity/hub/${getAntigravityLatestVersion()} ${ANTIGRAVITY_HUB_PLATFORM}`;
}

export async function refreshAntigravityVersion(httpClient = axios) {
    try {
        const response = await httpClient.get(ANTIGRAVITY_VERSION_MANIFEST_URL, {
            headers: { 'User-Agent': 'electron-builder', 'Cache-Control': 'no-cache' },
            timeout: VERSION_FETCH_TIMEOUT_MS,
            responseType: 'text',
            transformResponse: data => data,
            maxContentLength: VERSION_MANIFEST_MAX_BYTES,
            validateStatus: status => status === 200
        });
        const version = parseAntigravityManifestVersion(response?.data);
        if (!version) throw new Error('manifest has no valid version');
        if (version !== cachedVersion) {
            logger.info(`[Antigravity] Client version updated: ${cachedVersion || ANTIGRAVITY_FALLBACK_VERSION} -> ${version}`);
        }
        cachedVersion = version;
        cachedAt = Date.now();
        return version;
    } catch (error) {
        // Keep serving the cached or fallback version; never block requests on this.
        logger.warn(`[Antigravity] Failed to refresh client version: ${error.message}`);
        return null;
    }
}

/** Starts the singleton background refresh; safe to call from every service constructor. */
export function ensureAntigravityVersionUpdater() {
    // Unit tests construct services freely and must not reach the network.
    if (refreshTimer || process.env.NODE_ENV === 'test') return;
    void refreshAntigravityVersion();
    refreshTimer = setInterval(() => void refreshAntigravityVersion(), VERSION_REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
}

export function resetAntigravityVersionForTests() {
    cachedVersion = null;
    cachedAt = 0;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
}
