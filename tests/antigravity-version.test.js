import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
    ANTIGRAVITY_FALLBACK_VERSION,
    getAntigravityLatestVersion,
    getAntigravityUserAgent,
    parseAntigravityManifestVersion,
    parseAntigravityUserAgentVersion,
    refreshAntigravityVersion,
    resetAntigravityVersionForTests
} from '../src/providers/gemini/antigravity-version.js';

const manifest = version => `version: ${version}\nfiles:\n  - url: https://example.test/Antigravity.zip\npath: Antigravity.zip\n`;

describe('Antigravity client version', () => {
    afterEach(() => {
        resetAntigravityVersionForTests();
    });

    test('parses a strict N.N.N version from the Hub manifest', () => {
        expect(parseAntigravityManifestVersion(manifest('2.24.0'))).toBe('2.24.0');
        expect(parseAntigravityManifestVersion(manifest('"2.24.0"'))).toBe('2.24.0');
        expect(parseAntigravityManifestVersion(manifest('2.24.0-beta'))).toBeNull();
        expect(parseAntigravityManifestVersion('files: []')).toBeNull();
        expect(parseAntigravityManifestVersion(undefined)).toBeNull();
    });

    test('extracts the version from every Antigravity user agent shape', () => {
        expect(parseAntigravityUserAgentVersion('antigravity/2.9.1 darwin/arm64')).toBe('2.9.1');
        expect(parseAntigravityUserAgentVersion('antigravity/hub/2.23.0 darwin/arm64')).toBe('2.23.0');
        expect(parseAntigravityUserAgentVersion('antigravity/cli/1.3.1 (aidev_client; os_type=darwin; arch=arm64)')).toBe('1.3.1');
        expect(parseAntigravityUserAgentVersion('Mozilla/5.0')).toBe('');
        expect(parseAntigravityUserAgentVersion(undefined)).toBe('');
    });

    test('falls back to the floor version before any manifest was fetched', () => {
        expect(getAntigravityLatestVersion()).toBe(ANTIGRAVITY_FALLBACK_VERSION);
        expect(getAntigravityUserAgent()).toBe('antigravity/hub/2.23.0 darwin/arm64');
    });

    test('uses a fetched version and sends the electron-builder request', async () => {
        const get = jest.fn().mockResolvedValue({ data: manifest('2.24.0') });

        await expect(refreshAntigravityVersion({ get })).resolves.toBe('2.24.0');

        expect(getAntigravityUserAgent()).toBe('antigravity/hub/2.24.0 darwin/arm64');
        expect(get).toHaveBeenCalledWith(
            expect.stringContaining('/manifest/latest-arm64-mac.yml'),
            expect.objectContaining({
                headers: expect.objectContaining({ 'User-Agent': 'electron-builder' }),
                timeout: 10000
            })
        );
    });

    test('keeps the cached version when a refresh fails or returns garbage', async () => {
        await refreshAntigravityVersion({ get: jest.fn().mockResolvedValue({ data: manifest('2.24.0') }) });

        await expect(refreshAntigravityVersion({ get: jest.fn().mockRejectedValue(new Error('network down')) })).resolves.toBeNull();
        await expect(refreshAntigravityVersion({ get: jest.fn().mockResolvedValue({ data: 'not a manifest' }) })).resolves.toBeNull();

        expect(getAntigravityLatestVersion()).toBe('2.24.0');
    });

    test('never serves a fetched version below the 2.23.0 floor', async () => {
        await refreshAntigravityVersion({ get: jest.fn().mockResolvedValue({ data: manifest('2.22.9') }) });

        expect(getAntigravityLatestVersion()).toBe(ANTIGRAVITY_FALLBACK_VERSION);
    });

    test('drops a cached version after the six-hour TTL', async () => {
        await refreshAntigravityVersion({ get: jest.fn().mockResolvedValue({ data: manifest('2.24.0') }) });

        expect(getAntigravityLatestVersion(Date.now() + 5 * 60 * 60 * 1000)).toBe('2.24.0');
        expect(getAntigravityLatestVersion(Date.now() + 7 * 60 * 60 * 1000)).toBe(ANTIGRAVITY_FALLBACK_VERSION);
    });
});
