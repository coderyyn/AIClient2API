import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/common.js', () => ({
    getRequestBody: jest.fn(async () => ({
        targetProviderUuid: 'provider-1',
        proxyId: 'missing-proxy'
    }))
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    handleGeminiCliOAuth: jest.fn(),
    handleGeminiAntigravityOAuth: jest.fn(),
    batchImportGeminiTokensStream: jest.fn(),
    handleQwenOAuth: jest.fn(),
    handleKiroOAuth: jest.fn(),
    handleIFlowOAuth: jest.fn(),
    handleCodexOAuth: jest.fn(),
    handleCodexOAuthCallback: jest.fn(),
    handleGrokCliOAuth: jest.fn(),
    batchImportCodexTokensStream: jest.fn(),
    batchImportGrokCliTokensStream: jest.fn(),
    batchImportKiroRefreshTokensStream: jest.fn(),
    importAwsCredentials: jest.fn(),
    batchImportGrokTokensStream: jest.fn()
}));

import { getRequestBody } from '../src/utils/common.js';
import { handleCodexOAuth, handleCodexOAuthCallback } from '../src/auth/oauth-handlers.js';
import { handleGenerateAuthUrl, handleManualOAuthCallback } from '../src/ui-modules/oauth-api.js';

describe('Codex OAuth URL API errors', () => {
    test('returns an HTTP failure instead of success with an empty auth URL', async () => {
        handleCodexOAuth.mockResolvedValue({
            success: false,
            error: 'Selected proxy node is unavailable: missing-proxy'
        });
        const req = {
            headers: { host: 'localhost:3000' }
        };
        const response = {
            status: null,
            body: null,
            writeHead(status) {
                this.status = status;
            },
            end(body) {
                this.body = JSON.parse(body);
            }
        };

        await handleGenerateAuthUrl(req, response, {}, 'openai-codex-oauth');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            error: {
                message: 'Selected proxy node is unavailable: missing-proxy'
            }
        });
    });

    test('returns HTTP 400 when a Codex manual callback is rejected', async () => {
        getRequestBody.mockResolvedValueOnce({
            provider: 'openai-codex-oauth',
            callbackUrl: 'http://localhost:1455/auth/callback?code=code-1&state=session-1'
        });
        handleCodexOAuthCallback.mockResolvedValueOnce({
            success: false,
            error: 'Invalid or expired OAuth session'
        });
        const response = {
            status: null,
            body: null,
            writeHead(status) {
                this.status = status;
            },
            end(body) {
                this.body = JSON.parse(body);
            }
        };

        await handleManualOAuthCallback({}, response);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            error: {
                message: 'Invalid or expired OAuth session'
            }
        });
    });
});
