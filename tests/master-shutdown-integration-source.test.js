import fs from 'fs';
import path from 'path';

describe('master shutdown integration source', () => {
    test('wires lifecycle state into stop, restart and auto-restart decisions', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/core/master.js'), 'utf8')
            .replace(/\r\n/g, '\n');

        expect(source).toContain('createWorkerLifecycle');
        expect(source).toContain('workerLifecycle.stop');
        expect(source).toContain('workerLifecycle.shouldAutoRestart');
        expect(source).toContain('restartAfterGracefulStop');
        expect(source).toContain('workerLifecycle.beginRestartIntent()');
        expect(source).toContain('workerLifecycle.isIntentCurrent(restartIntent)');
        expect(source).toContain('isStopping: workerLifecycle.isStopping()');
    });

    test('routes SIGTERM and SIGINT through one master shutdown coordinator', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/core/master.js'), 'utf8')
            .replace(/\r\n/g, '\n');

        expect(source).toContain('createMasterShutdownCoordinator');
        expect(source).toContain("requestMasterShutdown({ trigger: 'SIGTERM' })");
        expect(source).toContain("requestMasterShutdown({ trigger: 'SIGINT' })");
    });

    test('routes the explicit start endpoint through the intent-aware starter', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/core/master.js'), 'utf8')
            .replace(/\r\n/g, '\n');
        const endpointStart = source.indexOf("if (method === 'POST' && path === '/master/start')");
        const endpointEnd = source.indexOf('// 健康检查', endpointStart);
        const endpointSource = source.slice(endpointStart, endpointEnd);

        expect(source).toContain('createExplicitWorkerStarter');
        expect(source).toContain('const startWorkerExplicitly = createExplicitWorkerStarter');
        expect(endpointSource).toContain('const result = startWorkerExplicitly();');
    });

    test('captures auto-restart intent before the backoff so a later explicit stop wins', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/core/master.js'), 'utf8')
            .replace(/\r\n/g, '\n');
        const scheduleStart = source.indexOf('function scheduleRestart()');
        const scheduleEnd = source.indexOf('function handleWorkerMessage', scheduleStart);
        const scheduleSource = source.slice(scheduleStart, scheduleEnd);

        expect(scheduleSource).toContain(
            'const restartIntent = workerLifecycle.beginRestartIntent();'
        );
        expect(scheduleSource).toContain('restartWorker(restartIntent);');
    });

    test('validates a pending restart intent before mutating restart status', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/core/master.js'), 'utf8')
            .replace(/\r\n/g, '\n');
        const restartStart = source.indexOf('async function restartWorker');
        const restartEnd = source.indexOf('/**\n * 计划重启', restartStart);
        const restartSource = source.slice(restartStart, restartEnd);
        const intentCheck = restartSource.indexOf('workerLifecycle.isIntentCurrent(restartIntent)');
        const statusMutation = restartSource.indexOf('workerStatus.isRestarting = true;');

        expect(intentCheck).toBeGreaterThanOrEqual(0);
        expect(statusMutation).toBeGreaterThan(intentCheck);
    });
});
