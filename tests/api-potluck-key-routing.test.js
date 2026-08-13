import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockAtomicWriteFile = jest.fn();
const mockAtomicWriteFileSync = jest.fn();

jest.mock('../src/utils/file-lock.js', () => ({
    atomicWriteFile: mockAtomicWriteFile,
    atomicWriteFileSync: mockAtomicWriteFileSync
}));

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

function getStorePath() {
    return path.join(tempDir, 'configs', 'api-potluck-keys.json');
}

function writeStore(store) {
    fs.writeFileSync(getStorePath(), JSON.stringify(store), 'utf8');
}

function readStore() {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
}

function writeAdminToken(token = 'admin-token') {
    fs.writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({
        tokens: {
            [token]: { expiryTime: Date.now() + 60_000 }
        }
    }));
    return token;
}

async function loadPotluckModules() {
    const [{ default: plugin }, keyManager, apiRoutes] = await Promise.all([
        import('../src/plugins/api-potluck/index.js'),
        import('../src/plugins/api-potluck/key-manager.js'),
        import('../src/plugins/api-potluck/api-routes.js')
    ]);
    return { plugin, keyManager, apiRoutes };
}

async function callPotluckRoute(handler, method, routePath, body, token = 'admin-token') {
    let statusCode = null;
    let responseBody = '';
    const req = {
        url: routePath,
        headers: { authorization: `Bearer ${token}`, host: 'localhost' },
        on(event, callback) {
            if (event === 'data' && body !== undefined) {
                callback(Buffer.from(JSON.stringify(body)));
            }
            if (event === 'end') callback();
            return this;
        },
        resume() {},
        destroy() {}
    };
    const res = {
        writeHead(code) {
            statusCode = code;
        },
        end(value) {
            responseBody = value;
        }
    };

    await handler(method, routePath, req, res);
    return { statusCode, body: JSON.parse(responseBody) };
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-13T04:00:00.000Z'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-routing-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
    mockAtomicWriteFile.mockImplementation(async (filePath, data, options) => {
        fs.writeFileSync(filePath, data, options);
    });
    mockAtomicWriteFileSync.mockImplementation((filePath, data, options) => {
        fs.writeFileSync(filePath, data, options);
    });
});

afterEach(() => {
    consoleSpies.forEach(spy => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('API Potluck key credential routing', () => {
    test('creates new keys with safe auto-routing defaults', async () => {
        const { plugin } = await loadPotluckModules();
        const created = await plugin.exports.createKey('Default Routing', 1000);

        expect(created).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
        expect(readStore().keys[created.id]).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
    });

    test('normalizes legacy keys without routing fields on load', async () => {
        writeStore({
            keys: {
                maki_legacy: {
                    id: 'maki_legacy',
                    name: 'Legacy Key',
                    dailyLimit: 1000,
                    enabled: true,
                    lastResetDate: '2026-08-13'
                }
            }
        });

        const { keyManager } = await loadPotluckModules();
        expect(await keyManager.getKey('maki_legacy')).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
        expect(await keyManager.validateKey('maki_legacy')).toMatchObject({
            valid: true,
            keyData: {
                routingMode: 'auto',
                primaryGroupId: null,
                fixedCredential: null,
                manualLock: false
            }
        });
    });

    test('updates fixed and auto routing while rejecting fixed mode without a credential UUID', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Mutable Routing', 1000);

        await expect(keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: { providerType: 'openai-codex-oauth' }
        })).rejects.toMatchObject({ code: 'INVALID_KEY_ROUTING' });

        const fixed = await keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-fixed'
            },
            manualLock: true
        });
        expect(fixed).toMatchObject({
            routingMode: 'fixed',
            primaryGroupId: null,
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-fixed'
            },
            manualLock: true
        });

        const automatic = await keyManager.updateKeyRouting(created.id, {
            routingMode: 'auto',
            primaryGroupId: 'group-2',
            manualLock: false
        });
        expect(automatic).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: 'group-2',
            fixedCredential: null,
            manualLock: false
        });
    });

    test('returns a detached routing snapshot from key validation', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Validation Routing', 1000);
        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-validation'
            },
            manualLock: true
        });

        const validation = await keyManager.validateKey(created.id);
        expect(validation.keyData).toMatchObject({
            routingMode: 'fixed',
            primaryGroupId: null,
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-validation'
            },
            manualLock: true
        });
        expect(validation.keyData).not.toHaveProperty('usageHistory');

        validation.keyData.fixedCredential.uuid = 'mutated';
        expect((await keyManager.getKey(created.id)).fixedCredential.uuid).toBe('cred-validation');
    });

    test('keeps routing fields after persistence and module reload', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Reload Routing', 1000);
        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'auto',
            primaryGroupId: 'group-reload',
            manualLock: true
        });

        jest.resetModules();
        const reloaded = await import('../src/plugins/api-potluck/key-manager.js');
        expect(await reloaded.getKey(created.id)).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: 'group-reload',
            fixedCredential: null,
            manualLock: true
        });
    });

    test('updates routing through the authenticated management API', async () => {
        const { keyManager, apiRoutes } = await loadPotluckModules();
        const token = writeAdminToken();
        const created = await keyManager.createKey('API Routing', 1000);

        const response = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'PUT',
            `/api/potluck/keys/${encodeURIComponent(created.id)}/routing`,
            {
                routingMode: 'fixed',
                fixedCredential: {
                    providerType: 'openai-codex-oauth',
                    uuid: 'cred-api'
                },
                manualLock: true
            },
            token
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            persistencePending: false,
            data: {
                routingMode: 'fixed',
                primaryGroupId: null,
                fixedCredential: {
                    providerType: 'openai-codex-oauth',
                    uuid: 'cred-api'
                },
                manualLock: true
            }
        });
    });
});
