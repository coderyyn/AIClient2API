import { describe, expect, test } from '@jest/globals';
import { createErrorResponse, createStreamErrorResponse } from '../src/utils/common.js';

function createQuotaError() {
    const error = new Error('All Antigravity providers are cooling down for model gemini-3.1-flash-image');
    error.status = 429;
    error.quotaScope = 'model';
    error.quotaKey = 'gemini-3.1-flash-image';
    error.nextRecoveryTime = '2026-08-10T10:30:00.000Z';
    return error;
}

describe('Antigravity quota error responses', () => {
    test('adds compatible quota metadata to unary OpenAI errors', () => {
        expect(createErrorResponse(createQuotaError(), 'openai')).toEqual({
            error: {
                message: '[2API 内部] 服务处理请求失败，请稍后重试',
                type: 'rate_limit_error',
                code: 'rate_limit_error',
                quota_scope: 'model',
                quota_key: 'gemini-3.1-flash-image',
                next_recovery_time: '2026-08-10T10:30:00.000Z'
            }
        });
    });

    test('adds compatible quota metadata to streaming OpenAI errors', () => {
        const payload = createStreamErrorResponse(createQuotaError(), 'openai');
        const body = JSON.parse(payload.replace(/^data: /, '').trim());

        expect(body.error).toMatchObject({
            type: 'rate_limit_error',
            quota_scope: 'model',
            quota_key: 'gemini-3.1-flash-image',
            next_recovery_time: '2026-08-10T10:30:00.000Z'
        });
    });
});
