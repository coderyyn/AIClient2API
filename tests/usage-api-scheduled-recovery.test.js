import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn()
}));

jest.mock('../src/services/usage-service.js', () => ({
    usageService: {
        getFormattedUsage: jest.fn()
    }
}));

import { getServiceAdapter } from '../src/providers/adapter.js';
import { usageService } from '../src/services/usage-service.js';
import { getAllProvidersUsage } from '../src/ui-modules/usage-api.js';

describe('usage api scheduled recovery handling', () => {
    test('skips disabled providers without surfacing refresh errors', async () => {
        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'gemini-cli-oauth': [
                    {
                        uuid: 'disabled-gemini',
                        customName: 'Disabled Gemini',
                        isDisabled: true,
                        isHealthy: true
                    }
                ]
            }
        });

        expect(getServiceAdapter).not.toHaveBeenCalled();
        expect(usageService.getFormattedUsage).not.toHaveBeenCalled();
        expect(usage.providers['gemini-cli-oauth']).toMatchObject({
            totalCount: 1,
            successCount: 0,
            errorCount: 0
        });
        expect(usage.providers['gemini-cli-oauth'].instances[0]).toMatchObject({
            uuid: 'disabled-gemini',
            success: false,
            skipped: true,
            error: null,
            skipReason: 'disabled'
        });
    });

    test('skips Codex usage refresh while a provider is waiting for scheduled recovery', async () => {
        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'openai-codex-oauth': [
                    {
                        uuid: 'cooling-codex',
                        customName: 'Cooling Codex',
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
                    }
                ]
            }
        });

        expect(getServiceAdapter).not.toHaveBeenCalled();
        expect(usageService.getFormattedUsage).not.toHaveBeenCalled();
        expect(usage.providers['openai-codex-oauth'].instances[0]).toMatchObject({
            uuid: 'cooling-codex',
            success: false,
            error: 'Provider is waiting for scheduled recovery until 2099-01-01T00:00:00.000Z'
        });
    });
});
