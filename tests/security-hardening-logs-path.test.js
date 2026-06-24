import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('security hardening allowed paths', () => {
    test('allows plugin-triggered logger cleanup to read the logs directory itself', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-security-'));
        const repoRoot = process.cwd();
        try {
            fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'logs', 'app-2026-06-24.log'), 'ok\n', 'utf8');
            fs.mkdirSync(path.join(tempDir, 'src', 'plugins', 'probe'), { recursive: true });

            const loggerUrl = pathToFileUrl(path.join(repoRoot, 'src', 'utils', 'logger.js'));
            fs.writeFileSync(path.join(tempDir, 'src', 'plugins', 'probe', 'index.js'), `
                import { Logger } from ${JSON.stringify(loggerUrl)};

                export function run() {
                    const logger = new Logger();
                    logger.initialize({
                        outputMode: 'console',
                        logDir: 'logs',
                        maxFiles: 100,
                        retentionDays: 7
                    });
                    logger.cleanupOldLogs();
                    logger.close();
                }
            `, 'utf8');

            const hardeningUrl = pathToFileUrl(path.join(repoRoot, 'src', 'core', 'security-hardening.js'));
            const pluginUrl = pathToFileUrl(path.join(tempDir, 'src', 'plugins', 'probe', 'index.js'));
            const script = `
                await import(${JSON.stringify(hardeningUrl)});
                const plugin = await import(${JSON.stringify(pluginUrl)});
                plugin.run();
                console.log('logs-ok');
            `;

            const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
                cwd: tempDir,
                encoding: 'utf8'
            });
            const output = `${result.stdout}\n${result.stderr}`;

            expect(result.status).toBe(0);
            expect(output).toContain('logs-ok');
            expect(output).not.toContain('Permission Denied');
            expect(output).not.toContain('Failed to cleanup old logs');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

function pathToFileUrl(filePath) {
    return `file:///${path.resolve(filePath).replace(/\\/g, '/')}`;
}
