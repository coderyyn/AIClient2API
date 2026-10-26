import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { createProviderSelectionError } from '../src/services/service-manager.js';
import { handleError } from '../src/utils/common.js';
import requestContext from '../src/utils/context.js';
import { instrumentResponseForAudit } from '../src/utils/request-audit-lifecycle.js';
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';
import { closeProviderLeaseScope } from '../src/runtime/provider-lease-scope.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(), getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/providers/provider-models.js', () => ({
    ...jest.requireActual('../src/providers/provider-models.js'),
    getProviderModels: jest.fn(() => [])
}));

const primary = 'openai-custom';
const backup = 'openai-custom-backup';
const model = 'gpt-test';
const busy = (extra = {}) => Object.assign(new Error('Account concurrency limit and queue reached'), {
    status: 429, code: 429, details: { reason: 'PROVIDER_QUEUE_EXHAUSTED' }, ...extra
});
const quota = () => Object.assign(new Error('Model quota exhausted'), {
    status: 429, code: 429, quotaScope: 'model', retryAfter: '2030-01-01T00:00:00Z'
});

function manager() {
    // Exercise the real fallback method without timers, persistence or live credentials.
    return Object.assign(Object.create(ProviderPoolManager.prototype), {
        globalConfig: {}, providerStatus: { [primary]: [{}], [backup]: [{}] },
        fallbackChain: {}, modelFallbackMapping: {}, _log: jest.fn(),
        _isAntigravityElasticRoutingEligible: jest.fn(() => false),
        acquireSlotFromMixedPool: jest.fn().mockResolvedValue(null),
        acquireSlot: jest.fn().mockResolvedValue(null)
    });
}

describe('fallback preserves capacity and quota errors', () => {
    test.each([
        {}, { status: undefined, statusCode: 429 }, { status: undefined },
        { code: 'PROVIDER_CONCURRENCY_EXHAUSTED' },
        { status: undefined, code: 'PROVIDER_CONCURRENCY_EXHAUSTED' }
    ])('normalizes legacy and structured concurrency errors: %j', async extra => {
        const pool = manager();
        pool.acquireSlot.mockRejectedValueOnce(busy(extra));
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toMatchObject({
            status: 429, statusCode: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED'
        });
    });

    test('preserves capacity exhaustion on the Codex route with no fallback', async () => {
        const pool = manager();
        pool.providerStatus['openai-codex-oauth'] = [{}];
        pool.acquireSlot.mockRejectedValueOnce(busy());
        await expect(pool.acquireSlotWithFallback('openai-codex-oauth', 'gpt-5.6-luna'))
            .rejects.toMatchObject({ status: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
    });

    test('keeps a successful channel fallback and its call order', async () => {
        const pool = manager();
        pool.fallbackChain[primary] = [backup];
        pool.acquireSlot.mockRejectedValueOnce(busy()).mockResolvedValueOnce({ uuid: 'backup' });
        await expect(pool.acquireSlotWithFallback(primary, model)).resolves.toMatchObject({
            config: { uuid: 'backup' }, actualProviderType: backup, isFallback: true
        });
        expect(pool.acquireSlot.mock.calls.map(call => call[0])).toEqual([primary, backup]);
    });

    test.each(['empty', 'busy'])('keeps the first capacity rejection when fallback is %s', async outcome => {
        const pool = manager();
        pool.fallbackChain[primary] = [backup];
        pool.acquireSlot.mockRejectedValueOnce(busy());
        if (outcome === 'busy') pool.acquireSlot.mockRejectedValueOnce(busy());
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toMatchObject({
            status: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED'
        });
    });

    test.each([true, false])('quota takes precedence over capacity in either order: %s', async quotaFirst => {
        const pool = manager();
        pool.fallbackChain[primary] = [backup];
        const limited = quota();
        pool.acquireSlot.mockRejectedValueOnce(quotaFirst ? limited : busy())
            .mockRejectedValueOnce(quotaFirst ? busy() : limited);
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toBe(limited);
    });

    test.each(['empty', 'busy', 'success'])('preserves configured model fallback: %s', async outcome => {
        const pool = manager();
        pool.globalConfig.CODEX_UNAVAILABLE_MODEL_FALLBACKS = { [model]: 'gpt-test-small' };
        pool.acquireSlot.mockRejectedValueOnce(busy());
        if (outcome === 'success') pool.acquireSlot.mockResolvedValueOnce({ uuid: 'small' });
        if (outcome === 'busy') pool.acquireSlot.mockRejectedValueOnce(busy());
        const result = pool.acquireSlotWithFallback(primary, model);
        if (outcome === 'success') {
            await expect(result).resolves.toMatchObject({ actualModel: 'gpt-test-small' });
        } else {
            await expect(result).rejects.toMatchObject({ status: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
        }
        expect(pool.acquireSlot).toHaveBeenNthCalledWith(2, primary, 'gpt-test-small', {});
    });

    test('keeps the source quota error when model fallback is also full', async () => {
        const pool = manager();
        pool.globalConfig.CODEX_UNAVAILABLE_MODEL_FALLBACKS = { [model]: 'gpt-test-small' };
        const limited = quota();
        pool.acquireSlot.mockRejectedValueOnce(limited).mockRejectedValueOnce(busy());
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toBe(limited);
    });

    test.each(['empty', 'busy', 'success'])('handles a mapped target and its channel fallback: %s', async outcome => {
        const pool = manager();
        pool.modelFallbackMapping[model] = { targetProviderType: primary, targetModel: 'gpt-mapped' };
        pool.fallbackChain[primary] = [backup];
        pool.acquireSlot.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
            .mockRejectedValueOnce(busy());
        if (outcome === 'success') pool.acquireSlot.mockResolvedValueOnce({ uuid: 'mapped-backup' });
        if (outcome === 'busy') pool.acquireSlot.mockRejectedValueOnce(busy());
        const result = pool.acquireSlotWithFallback(primary, model);
        if (outcome === 'success') {
            await expect(result).resolves.toMatchObject({ actualModel: 'gpt-mapped', actualProviderType: backup });
        } else {
            await expect(result).rejects.toMatchObject({ status: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
        }
    });

    test.each(['primary', 'channel', 'model', 'mapped', 'mapped-channel'])('does not swallow non-429 exceptions at %s', async stage => {
        const pool = manager();
        const failure = Object.assign(new Error('Internal coordinator failure'), { status: 500 });
        if (stage === 'channel') {
            pool.fallbackChain[primary] = [backup];
            pool.acquireSlot.mockRejectedValueOnce(busy());
        } else if (stage === 'model') {
            pool.globalConfig.CODEX_UNAVAILABLE_MODEL_FALLBACKS = { [model]: 'gpt-test-small' };
            pool.acquireSlot.mockRejectedValueOnce(busy());
        } else if (stage.startsWith('mapped')) {
            pool.modelFallbackMapping[model] = { targetProviderType: primary, targetModel: 'gpt-mapped' };
            pool.acquireSlot.mockResolvedValueOnce(null);
            if (stage === 'mapped-channel') {
                pool.fallbackChain[primary] = [backup];
                pool.acquireSlot.mockResolvedValueOnce(null).mockRejectedValueOnce(busy());
            }
        }
        pool.acquireSlot.mockRejectedValueOnce(failure);
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toBe(failure);
    });

    test('retains null/503 for genuinely unavailable credentials', async () => {
        const pool = manager();
        await expect(pool.acquireSlotWithFallback(primary, model)).resolves.toBeNull();
        expect(createProviderSelectionError(primary, model, {}, { acquireSlot: true }))
            .toMatchObject({ status: 503, code: 'PROVIDER_CREDENTIALS_UNAVAILABLE' });
    });

    test('preserves an unclassified 429 instead of inventing a concurrency cause', async () => {
        const pool = manager();
        const limited = Object.assign(new Error('Rate limited'), { status: 429, code: 'MODEL_RATE_LIMITED' });
        pool.acquireSlot.mockRejectedValueOnce(limited);
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toBe(limited);
    });

    test('normalizes capacity when provider fallback is disabled', async () => {
        const pool = manager();
        pool.acquireSlot.mockRejectedValueOnce(busy());
        await expect(pool.acquireSlotWithFallback(primary, model, { disableProviderFallback: true }))
            .rejects.toMatchObject({ status: 429, statusCode: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
    });

    test('does not turn an explicit internal error into capacity exhaustion', async () => {
        const pool = manager();
        const error = busy({ status: 500 });
        pool.acquireSlot.mockRejectedValueOnce(error);
        await expect(pool.acquireSlotWithFallback(primary, model)).rejects.toBe(error);
        expect(error.status).toBe(500);
    });

    test.each([false, true])('real slot acquisition leaves no leases after request completion: fallback success=%s', async success => {
        const pool = manager();
        pool.fallbackChain[primary] = [backup];
        pool.providerStatus = Object.fromEntries([primary, backup].map(type => [type, [{
            uuid: type, type, config: { uuid: type, concurrencyLimit: 5, queueLimit: 0 }
        }]]));
        pool.acquireSlot = ProviderPoolManager.prototype.acquireSlot;
        pool._hydrateCodexPoolSnapshot = jest.fn();
        pool._getHealthyProvidersForType = jest.fn(type => pool.providerStatus[type]);
        pool._orderCoordinatedCandidates = candidates => candidates;
        pool._recordProviderSelectionLoad = jest.fn();
        pool.coordination = {
            acquire: jest.fn().mockRejectedValueOnce(busy()),
            release: jest.fn().mockResolvedValue(true)
        };
        if (success) pool.coordination.acquire.mockResolvedValueOnce({ leaseId: 'synthetic-lease', providerType: backup, uuid: backup });
        else pool.coordination.acquire.mockRejectedValueOnce(busy());
        const store = { requestId: 'synthetic-lease-test' };
        await requestContext.run(store, async () => {
            try {
                const result = pool.acquireSlotWithFallback(primary, model);
                if (success) {
                    await expect(result).resolves.toMatchObject({ actualProviderType: backup });
                    expect(store.providerLeaseScope.leases.size).toBe(1);
                } else {
                    await expect(result).rejects.toMatchObject({ status: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
                    expect(store.providerLeaseScope.leases.size).toBe(0);
                }
            } finally {
                await closeProviderLeaseScope(store);
            }
            expect(pool.coordination.acquire).toHaveBeenCalledTimes(2);
            expect(pool.coordination.release).toHaveBeenCalledTimes(success ? 1 : 0);
            expect(store.providerLeaseScope.leases.size).toBe(0);
            expect(store.providerLeaseScope.pending.size).toBe(0);
        });
    });

    test('keeps the selected error through API serialization and request auditing', async () => {
        const pool = manager();
        pool.acquireSlot.mockRejectedValueOnce(busy());
        const store = { requestAudit: {} };
        await requestContext.run(store, async () => {
            const response = Object.assign(new EventEmitter(), {
                headersSent: false, statusCode: 200, body: '',
                writeHead(status) { this.statusCode = status; this.headersSent = true; },
                end(body) { this.body = body; this.writableEnded = true; this.writableFinished = true; this.emit('finish'); }
            });
            let event;
            const lifecycle = instrumentResponseForAudit(response, facts => {
                event = buildRequestAuditEvent({ requestId: 'synthetic-capacity', model,
                    ...facts, ...store.requestAudit.terminal });
            }, { autoFinalize: false });
            lifecycle.markEligible();
            try { await pool.acquireSlotWithFallback(primary, model); }
            catch (error) { handleError(response, error, primary, 'openai'); }
            await lifecycle.complete();
            expect(response.statusCode).toBe(429);
            expect(JSON.parse(response.body).error.code).toBe('PROVIDER_CONCURRENCY_EXHAUSTED');
            expect(event.status).toMatchObject({ httpStatus: 429, errorClass: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
            expect(event.failure).toMatchObject({ source: 'internal', code: 'PROVIDER_CONCURRENCY_EXHAUSTED' });
            expect(pool.acquireSlot).toHaveBeenCalledTimes(1);
            expect(store.providerLeaseScope?.leases?.size || 0).toBe(0);
        });
    });
});
