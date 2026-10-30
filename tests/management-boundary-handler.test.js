jest.mock('../src/ui-modules/auth.js', () => ({ checkAuth: jest.fn(async () => false) }));
import { EventEmitter } from 'events';
import requestContext from '../src/utils/context.js';
import { getProviderLeaseScope, registerProviderLease } from '../src/runtime/provider-lease-scope.js';
import { createRequestHandler } from '../src/handlers/request-handler.js';
import { checkAuth } from '../src/ui-modules/auth.js';
import { handleAPIRequests } from '../src/services/api-manager.js';

jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    runWithContext: (_id, callback) => callback()
} }));
jest.mock('../src/utils/common.js', () => ({
    getClientIp: () => ({ clientIp: '127.0.0.1', peerIp: '127.0.0.1' }),
    getRequestBody: jest.fn(),
    handleError: (res, error) => { res.statusCode = error.status || 500; res.end('{}'); }
}));
jest.mock('../src/services/ui-manager.js', () => ({ handleUIApiRequests: async () => false, serveStaticFiles: async () => false }));
jest.mock('../src/services/api-manager.js', () => ({ handleAPIRequests: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getApiService: jest.fn(), getProviderStatus: jest.fn(), getProviderPoolManager: () => null }));
jest.mock('../src/providers/adapter.js', () => ({ getRegisteredProviders: () => ['openai-codex-oauth'], isRegisteredProvider: type => type === 'openai-codex-oauth' }));
jest.mock('../src/utils/grok-assets-proxy.js', () => ({ handleGrokAssetsProxy: jest.fn() }));
jest.mock('../src/core/config-manager.js', () => ({ PROMPT_LOG_FILENAME: null }));
jest.mock('../src/core/plugin-manager.js', () => ({ getPluginManager: () => ({
    isPluginStaticPath: () => false, getPluginByStaticPath: () => null,
    executeRoutes: async () => { throw new Error('PLUGIN_MUST_NOT_RUN'); }, executeAuth: async () => ({ authorized: true }),
    executeMiddleware: async () => ({ handled: false }), executeHook: async () => {}
}) }));

class Response extends EventEmitter {
    constructor() { super(); this.statusCode = 200; this.headers = {}; }
    setHeader(name, value) { this.headers[name] = value; }
    writeHead(status) { this.statusCode = status; }
    write() { return true; }
    end() { this.writableEnded = this.writableFinished = true; this.emit('finish'); }
}

describe('management authentication before plugin dispatch', () => {
    test.each(['/api/plugins', '/api/potluck/keys', '/api/request-audit', '/api/gpt-diagnostics', '/api/grok/assets', '/provider_health', '/api/new-plugin-endpoint'])('%s is blocked before a plugin can run', async url => {
        checkAuth.mockResolvedValue(false);
        const req = new EventEmitter();
        Object.assign(req, { method: 'GET', url, headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } });
        const res = new Response();
        await createRequestHandler({ MODEL_PROVIDER: 'openai-codex-oauth', UI_ENABLED: true }, null)(req, res);
        expect(res.statusCode).toBe(401);
    });
    test.each(['/api/plugins/upload', '/api/plugins/install', '/api/plugins/%75pload/'])('%s is disabled before authentication or body parsing', async url => {
        delete process.env.PLUGIN_INSTALL_ENABLED;
        checkAuth.mockClear();
        const req = new EventEmitter();
        Object.assign(req, { method: 'POST', url, headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } });
        const res = new Response();
        await createRequestHandler({ MODEL_PROVIDER: 'openai-codex-oauth', UI_ENABLED: true }, null)(req, res);
        expect(res.statusCode).toBe(403);
        expect(checkAuth).not.toHaveBeenCalled();
    });
});
