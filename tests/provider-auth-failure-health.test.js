import { EventEmitter } from 'events';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = null;
        this.statusCode = null;
        this.body = '';
        this.writableEnded = false;
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
    }

    write(chunk) {
        this.body += String(chunk);
    }

    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

function createInvalidatedCodexTokenError() {
    const error = new Error('401 Unauthorized (non-stream): Your authentication token has been invalidated. Please try signing in again.');
    error.response = {
        status: 401,
        data: {
            error: {
                code: 'token_invalidated',
                message: 'Your authentication token has been invalidated. Please try signing in again.'
            }
        }
    };
    error.credentialMarkedUnhealthy = true;
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

function createCodexUsageLimitError() {
    const error = new Error('429 Too Many Requests (non-stream): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1782824810,"resets_in_seconds":4481}}');
    error.response = {
        status: 429,
        data: {
            error: {
                type: 'usage_limit_reached',
                message: 'The usage limit has been reached',
                plan_type: 'pro',
                resets_at: 1782824810,
                resets_in_seconds: 4481
            }
        }
    };
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

function createProviderPoolManager() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyImmediately: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        markCodexQuotaBucketUnhealthy: jest.fn(),
        releaseSlot: jest.fn()
    };
}

describe('provider auth failure health marking', () => {
    test('marks a unary Codex token_invalidated error immediately unhealthy in the provider pool', async () => {
        const error = createInvalidatedCodexTokenError();
        const service = {
            generateContent: jest.fn().mockRejectedValue(error)
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gpt-5.4-mini',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider'
        );

        expect(providerPoolManager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            expect.stringContaining('token has been invalidated')
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
        expect(res.statusCode).toBe(401);
    });

    test('marks a stream Codex token_invalidated error immediately unhealthy in the provider pool', async () => {
        const error = createInvalidatedCodexTokenError();
        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.4-mini',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider'
        );

        expect(providerPoolManager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            expect.stringContaining('token has been invalidated')
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
        expect(res.body).toContain('token has been invalidated');
    });

    test('marks a unary Codex 5.3 usage_limit_reached error as Codex 5.3 quota bucket cooldown without globally unhealthy provider', async () => {
        const error = createCodexUsageLimitError();
        const service = {
            generateContent: jest.fn().mockRejectedValue(error)
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gpt-5.3-codex-spark',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider',
            {
                CONFIG: {
                    RATE_LIMIT_COOLDOWN_ENABLED: true,
                    RATE_LIMIT_COOLDOWN_MS: 30000,
                    RATE_LIMIT_COOLDOWN_JITTER_MS: 0
                }
            }
        );

        expect(providerPoolManager.markCodexQuotaBucketUnhealthy).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            'codex53',
            '429 Too Many Requests - short cooldown',
            expect.any(Date)
        );
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
    });

    test('marks a stream Codex 5.3 usage_limit_reached error as Codex 5.3 quota bucket cooldown without globally unhealthy provider', async () => {
        const error = createCodexUsageLimitError();
        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.3-codex-spark',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider',
            {
                CONFIG: {
                    RATE_LIMIT_COOLDOWN_ENABLED: true,
                    RATE_LIMIT_COOLDOWN_MS: 30000,
                    RATE_LIMIT_COOLDOWN_JITTER_MS: 0
                }
            }
        );

        expect(providerPoolManager.markCodexQuotaBucketUnhealthy).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            'codex53',
            '429 Too Many Requests - short cooldown',
            expect.any(Date)
        );
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
    });
});
