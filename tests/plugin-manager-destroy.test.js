import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import logger from '../src/utils/logger.js';
import { PluginManager } from '../src/core/plugin-manager.js';

function enabledPlugin(name, destroy) {
    return {
        name,
        _enabled: true,
        destroy
    };
}

function captureRejection(promise) {
    return promise.then(
        () => undefined,
        error => error
    );
}

describe('PluginManager.destroyAll', () => {
    beforeEach(() => {
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        jest.spyOn(logger, 'warn').mockImplementation(() => {});
        jest.spyOn(logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('continues destroying later plugins after an earlier destroy fails', async () => {
        const manager = new PluginManager();
        const calls = [];
        const firstFailure = new Error('first destroy failed');
        const first = enabledPlugin('first-plugin', async () => {
            calls.push('first-plugin');
            throw firstFailure;
        });
        const second = enabledPlugin('second-plugin', async () => {
            calls.push('second-plugin');
        });
        manager.plugins = new Map([
            [first.name, first],
            [second.name, second]
        ]);
        manager.initialized = true;

        const error = await captureRejection(manager.destroyAll());

        expect(calls).toEqual(['first-plugin', 'second-plugin']);
        expect(error).toBeInstanceOf(AggregateError);
        expect(first._errorCount).toBe(1);
        expect(logger.info).toHaveBeenCalledWith('[PluginManager] Destroyed plugin: second-plugin');
        expect(manager.initialized).toBe(false);
    });

    test('reports every destroy failure through the aggregate error', async () => {
        const manager = new PluginManager();
        const firstFailure = new Error('disk flush failed');
        const secondFailure = new Error('worker drain failed');
        const first = enabledPlugin('usage-plugin', async () => {
            throw firstFailure;
        });
        const second = enabledPlugin('queue-plugin', async () => {
            throw secondFailure;
        });
        manager.plugins = new Map([
            [first.name, first],
            [second.name, second]
        ]);
        manager.initialized = true;

        const error = await captureRejection(manager.destroyAll());

        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toContain('usage-plugin');
        expect(error.message).toContain('disk flush failed');
        expect(error.message).toContain('queue-plugin');
        expect(error.message).toContain('worker drain failed');
        expect(error.errors).toHaveLength(2);
        expect(error.errors).toEqual([
            expect.objectContaining({
                pluginName: 'usage-plugin',
                cause: firstFailure
            }),
            expect.objectContaining({
                pluginName: 'queue-plugin',
                cause: secondFailure
            })
        ]);
        expect(first._errorCount).toBe(1);
        expect(second._errorCount).toBe(1);
        expect(manager.initialized).toBe(false);
    });

    test('normalizes non-Error destroy reasons without interrupting later plugins', async () => {
        const manager = new PluginManager();
        const calls = [];
        const reasons = [null, undefined, 'string destroy failed'];
        const plugins = reasons.map((reason, index) => enabledPlugin(`invalid-${index}`, async () => {
            calls.push(`invalid-${index}`);
            throw reason;
        }));
        const finalPlugin = enabledPlugin('final-plugin', async () => {
            calls.push('final-plugin');
        });
        manager.plugins = new Map([...plugins, finalPlugin].map(plugin => [plugin.name, plugin]));
        manager.initialized = true;

        const error = await captureRejection(manager.destroyAll());

        expect(calls).toEqual(['invalid-0', 'invalid-1', 'invalid-2', 'final-plugin']);
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toContain('invalid-0: Non-Error plugin rejection (null)');
        expect(error.message).toContain('invalid-1: Non-Error plugin rejection (undefined)');
        expect(error.message).toContain('invalid-2: Non-Error plugin rejection (string)');
        expect(error.message).not.toContain('string destroy failed');
        expect(error.errors).toHaveLength(3);
        error.errors.forEach((failure, index) => {
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toEqual(expect.objectContaining({
                pluginName: `invalid-${index}`,
                cause: reasons[index],
                reason: reasons[index]
            }));
            expect(plugins[index]._errorCount).toBe(1);
        });
        expect(logger.info).toHaveBeenCalledWith('[PluginManager] Destroyed plugin: final-plugin');
        expect(manager.initialized).toBe(false);
    });

    test('does not serialize or log arbitrary non-Error rejection payloads', async () => {
        const manager = new PluginManager();
        const toJSON = jest.fn(() => ({ secret: 'serialized-secret' }));
        const objectReason = {
            secret: 'object-secret',
            toJSON
        };
        const largeStringReason = `large-secret-${'x'.repeat(1024 * 1024)}`;
        const objectPlugin = enabledPlugin('object-plugin', async () => {
            throw objectReason;
        });
        const stringPlugin = enabledPlugin('string-plugin', async () => {
            throw largeStringReason;
        });
        manager.plugins = new Map([
            [objectPlugin.name, objectPlugin],
            [stringPlugin.name, stringPlugin]
        ]);
        manager.initialized = true;

        const error = await captureRejection(manager.destroyAll());

        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toContain('object-plugin: Non-Error plugin rejection (object)');
        expect(error.message).toContain('string-plugin: Non-Error plugin rejection (string)');
        expect(error.message.length).toBeLessThan(300);
        expect(error.message).not.toContain('object-secret');
        expect(error.message).not.toContain('large-secret');
        expect(error.message).not.toContain('serialized-secret');
        expect(toJSON).not.toHaveBeenCalled();
        const loggedMessages = logger.error.mock.calls.map(call => call.join(' ')).join('\n');
        expect(loggedMessages).not.toContain('object-secret');
        expect(loggedMessages).not.toContain('large-secret');
        expect(loggedMessages).not.toContain('serialized-secret');
    });

    test('does not throw when every enabled plugin is destroyed successfully', async () => {
        const manager = new PluginManager();
        const firstDestroy = jest.fn(async () => {});
        const secondDestroy = jest.fn(async () => {});
        const first = enabledPlugin('first-plugin', firstDestroy);
        const second = enabledPlugin('second-plugin', secondDestroy);
        manager.plugins = new Map([
            [first.name, first],
            [second.name, second]
        ]);
        manager.initialized = true;

        await expect(manager.destroyAll()).resolves.toBeUndefined();

        expect(firstDestroy).toHaveBeenCalledTimes(1);
        expect(secondDestroy).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('[PluginManager] Destroyed plugin: first-plugin');
        expect(logger.info).toHaveBeenCalledWith('[PluginManager] Destroyed plugin: second-plugin');
        expect(manager.initialized).toBe(false);
    });

    test('supports a shorter destroy operation timeout while continuing later plugins', async () => {
        const manager = new PluginManager();
        const never = new Promise(() => {});
        const finalDestroy = jest.fn(async () => {});
        const hanging = enabledPlugin('hanging-plugin', () => never);
        const final = enabledPlugin('final-plugin', finalDestroy);
        manager.plugins = new Map([
            [hanging.name, hanging],
            [final.name, final]
        ]);
        manager.initialized = true;

        const error = await captureRejection(manager.destroyAll({ operationTimeoutMs: 20 }));

        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toContain('timed out after 20ms');
        expect(finalDestroy).toHaveBeenCalledTimes(1);
        expect(manager.initialized).toBe(false);
    });

    test('allows the caller to disable the per-plugin destroy timeout', async () => {
        const manager = new PluginManager();
        let resolveDestroy;
        const pendingDestroy = new Promise(resolve => {
            resolveDestroy = resolve;
        });
        const plugin = enabledPlugin('draining-plugin', () => pendingDestroy);
        manager.plugins = new Map([[plugin.name, plugin]]);
        manager.initialized = true;

        const destroyPromise = manager.destroyAll({ operationTimeoutMs: null });
        const state = await Promise.race([
            destroyPromise.then(() => 'fulfilled', () => 'rejected'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 25))
        ]);

        expect(state).toBe('pending');
        resolveDestroy();
        await expect(destroyPromise).resolves.toBeUndefined();
        expect(manager.initialized).toBe(false);
    });
});
