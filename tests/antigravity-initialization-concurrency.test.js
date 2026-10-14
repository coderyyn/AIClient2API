jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(function OAuth2Client() {
        this.on = jest.fn();
        this.setCredentials = jest.fn();
    })
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));
jest.mock('../src/auth/oauth-handlers.js', () => ({ handleGeminiAntigravityOAuth: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

const createService = () => {
    const service = Object.create(AntigravityApiService.prototype);
    service.isInitialized = false;
    service.initializationPromise = null;
    service.initializationFailure = null;
    service.initializationFailureUntil = 0;
    service.projectId = 'configured-project';
    return service;
};

const createGenerationService = () => {
    const service = createService();
    service.config = { MODEL_LIST_CACHE_TTL_MS: 60000 };
    service.baseURLs = ['https://example.test'];
    service.availableModels = [];
    service._lastModelProbeSucceeded = false;
    service.authClient = {
        credentials: { access_token: 'synthetic-token', expiry_date: Date.now() + 3600000 },
        request: jest.fn()
    };
    service.loadCredentials = jest.fn(async () => {});
    service.discoverProjectAndModels = jest.fn(async () => 'configured-project');
    service.prepareRequestMetadata = jest.fn();
    const response = { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] } };
    service.callApi = jest.fn(async () => response);
    service.streamApi = jest.fn(async function* () { yield response; });
    return service;
};

const generationBody = () => ({ contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] });

const startGeneration = (service, stream = false) => stream
    ? service.generateContentStream('gemini-2.5-flash-lite', generationBody()).next()
    : service.generateContent('gemini-2.5-flash-lite', generationBody());

describe('Antigravity initialization lifecycle', () => {
    test.each([false, true])('cold generation waits for model discovery (stream=%s)', async stream => {
        const service = createGenerationService();
        let completeProbe;
        service.authClient.request.mockImplementation(() => new Promise(resolve => { completeProbe = resolve; }));
        let settled = false;
        const result = startGeneration(service, stream).then(
            value => { settled = true; return { value }; },
            error => { settled = true; return { error }; }
        );
        await new Promise(resolve => setImmediate(resolve));
        expect(service.isInitialized).toBe(true);
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(service.callApi).not.toHaveBeenCalled();
        expect(service.streamApi).not.toHaveBeenCalled();

        completeProbe({ data: { models: { 'gemini-2.5-flash-lite': {} } } });
        const outcome = await result;
        expect(outcome.error).toBeUndefined();
        expect(service.callApi.mock.calls.length + service.streamApi.mock.calls.length).toBe(1);
        const response = stream ? outcome.value.value : outcome.value;
        expect(response.candidates[0].finishReason).toBe('STOP');
    });

    test('concurrent unary and stream requests share the background model probe', async () => {
        const service = createGenerationService();
        let completeProbe;
        service.authClient.request.mockImplementation(() => new Promise(resolve => { completeProbe = resolve; }));
        await service.initialize();
        await new Promise(resolve => setImmediate(resolve));
        const results = [startGeneration(service), startGeneration(service, true)].map(promise =>
            promise.then(value => ({ value }), error => ({ error })));
        await new Promise(resolve => setImmediate(resolve));
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
        expect(service.callApi).not.toHaveBeenCalled();
        expect(service.streamApi).not.toHaveBeenCalled();
        completeProbe({ data: { models: { 'gemini-2.5-flash-lite': {} } } });
        const outcomes = await Promise.all(results);
        expect(outcomes.every(outcome => !outcome.error)).toBe(true);
        expect(service.callApi).toHaveBeenCalledTimes(1);
        expect(service.streamApi).toHaveBeenCalledTimes(1);
        await startGeneration(service);
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
    });

    test('failed discovery remains unavailable and uses its short negative cache', async () => {
        const service = createGenerationService();
        service.authClient.request.mockRejectedValue(new Error('synthetic discovery outage'));
        await expect(startGeneration(service)).rejects.toMatchObject({ code: 'MODEL_LIST_UNAVAILABLE', status: 503 });
        await expect(startGeneration(service, true)).rejects.toMatchObject({ code: 'MODEL_LIST_UNAVAILABLE', status: 503 });
        await new Promise(resolve => setImmediate(resolve));
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
        expect(service.availableModels).toEqual([]);
        expect(service.callApi).not.toHaveBeenCalled();
        expect(service.streamApi).not.toHaveBeenCalled();
    });

    test('successful discovery cannot authorize a model absent from the account directory', async () => {
        const service = createGenerationService();
        service.authClient.request.mockResolvedValue({ data: { models: { 'gemini-2.5-flash': {} } } });
        await expect(startGeneration(service)).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED', status: 400 });
        await new Promise(resolve => setImmediate(resolve));
        expect(service.callApi).not.toHaveBeenCalled();
    });

    test('caches provider model probes and re-probes after token identity changes', async () => {
        const service = createService();
        service.baseURLs = ['https://example.test'];
        service.projectId = 'project-1';
        service.config = { MODEL_LIST_CACHE_TTL_MS: 60000 };
        service.authClient = {
            credentials: { access_token: 'token-a' },
            request: jest.fn().mockResolvedValue({ data: { models: { 'gemini-3.1-flash-image': {} } } })
        };

        await service.fetchAvailableModels();
        await service.fetchAvailableModels();
        expect(service.authClient.request).toHaveBeenCalledTimes(1);

        service.authClient.credentials.access_token = 'token-b';
        await service.fetchAvailableModels();
        expect(service.authClient.request).toHaveBeenCalledTimes(2);
    });

    test('coalesces concurrent provider model probes', async () => {
        const service = createService();
        service.baseURLs = ['https://example.test'];
        service.projectId = 'project-1';
        service.config = { MODEL_LIST_CACHE_TTL_MS: 60000 };
        let release;
        service.authClient = {
            credentials: { access_token: 'token-a' },
            request: jest.fn(() => new Promise(resolve => {
                release = () => resolve({ data: { models: { 'gemini-3.1-flash-image': {} } } });
            }))
        };

        const first = service.fetchAvailableModels();
        const second = service.fetchAvailableModels();
        await Promise.resolve();
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, second]);
    });

    test('schedules a background model probe without blocking initialization', async () => {
        const service = createService();
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn(async fetchModels => {
            expect(fetchModels).toBe(false);
            return 'configured-project';
        });
        service.fetchAvailableModels = jest.fn(async () => {});

        await service._initializeOnce();
        expect(service.fetchAvailableModels).not.toHaveBeenCalled();
        expect(service.isInitialized).toBe(true);

        await new Promise(resolve => setImmediate(resolve));
        expect(service.fetchAvailableModels).toHaveBeenCalledTimes(1);
    });

    test('shares one initialization promise across concurrent callers', async () => {
        const service = createService();
        let resolveDiscovery;
        const discoverProjectAndModels = jest.fn(() => new Promise(resolve => {
            resolveDiscovery = resolve;
        }));
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = discoverProjectAndModels;

        const first = service._ensureInitialized();
        const second = service._ensureInitialized();
        const third = service._ensureInitialized();
        await Promise.resolve();

        expect(discoverProjectAndModels).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
        expect(second).toBe(third);

        resolveDiscovery('configured-project');
        await Promise.all([first, second, third]);
        expect(service.isInitialized).toBe(true);
    });

    test('enters a 30 second cooldown after initialization failure', async () => {
        const service = createService();
        const failure = new Error('upstream unavailable');
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn(async () => { throw failure; });

        await expect(service._ensureInitialized()).rejects.toBe(failure);
        expect(service.initializationFailure).toBe(failure);
        expect(service.initializationFailureUntil).toBeGreaterThan(Date.now());

        await expect(service._ensureInitialized()).rejects.toMatchObject({
            code: 'PROVIDER_INITIALIZATION_COOLDOWN',
            statusCode: 503,
            retryAfter: 30,
            cause: failure,
        });
        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(1);
    });

    test('allows one retry after cooldown and clears failure state on success', async () => {
        const service = createService();
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest
            .fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce('configured-project');

        await expect(service._ensureInitialized()).rejects.toThrow('temporary failure');
        service.initializationFailureUntil = Date.now() - 1;

        await expect(service._ensureInitialized()).resolves.toBeUndefined();
        expect(service.isInitialized).toBe(true);
        expect(service.initializationFailure).toBeNull();
        expect(service.initializationFailureUntil).toBe(0);
        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(2);
    });

    test('stream, models, and usage entry points all use the same initialization gate', async () => {
        const service = createService();
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn(async () => 'configured-project');
        service.generateContent = jest.fn(async () => 'content');
        service.generateContentStream = jest.fn(async function* () { yield 'chunk'; });
        service.listModels = jest.fn(async () => []);
        service.getUsageLimits = jest.fn(async () => ({}));

        await service._ensureInitialized();
        await Promise.all([
            service._ensureInitialized(),
            service._ensureInitialized(),
            service._ensureInitialized(),
        ]);

        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(1);
    });
});
