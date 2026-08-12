import { resolveHealthcheckTarget } from '../src/runtime/healthcheck-target.js';

describe('resolveHealthcheckTarget', () => {
    test('多 Worker 模式默认检查公共运行时健康端点', () => {
        expect(resolveHealthcheckTarget({ RUNTIME_MULTI_WORKER_ENABLED: 'true' })).toEqual({
            host: '127.0.0.1',
            port: 3000,
            path: '/runtime/health'
        });
    });

    test('单 Worker 模式保留原有 master 健康检查默认值', () => {
        expect(resolveHealthcheckTarget({})).toEqual({
            host: '127.0.0.1',
            port: 3100,
            path: '/master/health'
        });
    });

    test('显式健康检查配置优先于运行模式默认值', () => {
        expect(resolveHealthcheckTarget({
            RUNTIME_MULTI_WORKER_ENABLED: 'true',
            HEALTHCHECK_HOST: '0.0.0.0',
            HEALTHCHECK_PORT: '3999',
            HEALTHCHECK_PATH: '/custom-health'
        })).toEqual({
            host: '0.0.0.0',
            port: 3999,
            path: '/custom-health'
        });
    });
});
