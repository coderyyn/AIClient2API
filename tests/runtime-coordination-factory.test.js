import { createRuntimeCoordination } from '../src/runtime/runtime-coordination.js';

describe('runtime coordination factory', () => {
    test('is disabled for control or legacy workers', () => {
        expect(createRuntimeCoordination({ env: {} })).toBeNull();
        expect(createRuntimeCoordination({ env: { RUNTIME_WORKER_ROLE: 'control', REDIS_URL: 'redis://localhost:6379' } })).toBeNull();
    });

    test('creates coordination for the control worker when multi-worker mode is enabled', () => {
        const coordination = createRuntimeCoordination({
            env: {
                RUNTIME_MULTI_WORKER_ENABLED: 'true',
                RUNTIME_WORKER_ROLE: 'control',
                RUNTIME_WORKER_ID: 'control-1',
                REDIS_URL: 'redis://redis:6379/0'
            }
        });
        expect(coordination.workerId).toBe('control-1');
    });

    test('requires Redis for execution workers and parses connection settings', () => {
        expect(() => createRuntimeCoordination({ env: { RUNTIME_WORKER_ROLE: 'execution' } }))
            .toThrow(/REDIS_URL/);
        const coordination = createRuntimeCoordination({
            env: {
                RUNTIME_WORKER_ROLE: 'execution',
                RUNTIME_WORKER_ID: 'execution-2',
                RUNTIME_DEPLOYMENT_EPOCH: 'green',
                REDIS_URL: 'redis://:password@redis.internal:6380/2'
            }
        });
        expect(coordination.workerId).toBe('execution-2');
        expect(coordination.epoch).toBe('green');
        expect(coordination.redis).toMatchObject({ host: 'redis.internal', port: 6380, password: 'password', database: 2 });
    });
});
