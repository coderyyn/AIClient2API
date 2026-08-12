import http from 'http';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { createRuntimeProxyHandler } from './runtime-proxy.js';
import { resolveWorkerTopology } from './worker-topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.join(__dirname, '../services/api-server.js');

export function startMultiWorkerRuntime({ env = process.env, args = process.argv.slice(2), logger = console } = {}) {
    const topology = resolveWorkerTopology(env);
    const publicPort = Number(env.RUNTIME_PUBLIC_PORT || 3000);
    const internalBasePort = Number(env.RUNTIME_INTERNAL_BASE_PORT || 3200);
    const epoch = env.RUNTIME_DEPLOYMENT_EPOCH || `local-${Date.now()}`;
    const workers = new Map();
    const ready = new Set();
    let shuttingDown = false;

    const spawnWorker = (role, index, port) => {
        const id = role === 'control' ? 'control-1' : `execution-${index + 1}`;
        const child = fork(workerScript, [...args, '--host', '127.0.0.1', '--port', String(port)], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: {
                ...env,
                IS_WORKER_PROCESS: 'true',
                RUNTIME_WORKER_ROLE: role,
                RUNTIME_WORKER_ID: id,
                RUNTIME_DEPLOYMENT_EPOCH: epoch
            }
        });
        workers.set(id, { id, role, port, child });
        child.on('message', message => {
            if (message?.type === 'ready') {
                ready.add(id);
                if (role === 'control') {
                    for (const worker of workers.values()) {
                        if (worker.role === 'execution' && worker.child.connected) worker.child.send({ type: 'runtime_hook_retry' });
                    }
                }
            }
            if (message?.type === 'runtime_hook') {
                workers.get('control-1')?.child.send({ ...message, sourceWorkerId: id });
            }
            if (message?.type === 'runtime_hook_ack') {
                const target = workers.get(message.sourceWorkerId);
                if (target?.child.connected) target.child.send(message);
            }
            if (message?.type === 'provider_state') {
                for (const worker of workers.values()) {
                    if (worker.child !== child && worker.child.connected) worker.child.send(message);
                }
            }
        });
        child.on('exit', (code, signal) => {
            ready.delete(id);
            workers.delete(id);
            if (!shuttingDown) {
                logger.error?.(`[Runtime] ${id} exited code=${code} signal=${signal}; restarting`);
                setTimeout(() => spawnWorker(role, index, port), 1000).unref?.();
            }
        });
        return child;
    };

    const controlPort = internalBasePort + 1;
    spawnWorker('control', 0, controlPort);
    const executionTargets = [];
    for (let index = 0; index < topology.executionWorkers; index++) {
        const port = internalBasePort + 11 + index;
        executionTargets.push({ host: '127.0.0.1', port });
        spawnWorker('execution', index, port);
    }

    const proxy = http.createServer(createRuntimeProxyHandler({
        controlTarget: { host: '127.0.0.1', port: controlPort },
        executionTargets,
        onProxyError: (error, detail) => logger.error?.(`[Runtime Proxy] ${detail.role} ${detail.target.port}: ${error.message}`),
        getRuntimeStatus: () => ({
            status: ready.size === topology.executionWorkers + 1 ? 'healthy' : 'starting',
            epoch,
            controlWorkers: [...workers.values()].filter(worker => worker.role === 'control').length,
            executionWorkers: [...workers.values()].filter(worker => worker.role === 'execution').length,
            readyWorkers: ready.size,
            coordination: 'redis',
            leaseRecovery: 'ready',
            persistenceBacklog: 0
        })
    }));
    proxy.requestTimeout = 0;
    proxy.headersTimeout = 60000;
    proxy.keepAliveTimeout = 65000;
    proxy.listen(publicPort, env.RUNTIME_PUBLIC_HOST || '0.0.0.0', () => {
        logger.info?.(`[Runtime] Public proxy listening on ${publicPort}; control=1 execution=${topology.executionWorkers} epoch=${epoch}`);
    });

    const shutdown = async exitCode => {
        if (shuttingDown) return;
        shuttingDown = true;
        await new Promise(resolve => proxy.close(resolve));
        const exits = [];
        for (const worker of workers.values()) {
            exits.push(new Promise(resolve => {
                const timeout = setTimeout(() => { worker.child.kill('SIGKILL'); resolve(); }, 30000);
                worker.child.once('exit', () => { clearTimeout(timeout); resolve(); });
                if (worker.child.connected) worker.child.send({ type: 'shutdown' });
                else worker.child.kill('SIGTERM');
            }));
        }
        await Promise.allSettled(exits);
        process.exit(exitCode);
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    return {
        proxy,
        workers,
        ready,
        topology,
        getStatus: () => ({
            status: ready.size === topology.executionWorkers + 1 ? 'healthy' : 'starting',
            epoch,
            controlWorkers: [...workers.values()].filter(worker => worker.role === 'control').length,
            executionWorkers: [...workers.values()].filter(worker => worker.role === 'execution').length,
            readyWorkers: ready.size
        }),
        shutdown
    };
}
