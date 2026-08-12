import { spawn } from 'child_process';
import { once } from 'events';

describe('mock runtime upstream', () => {
    let child;
    const port = 3907;

    beforeAll(async () => {
        child = spawn(process.execPath, ['scripts/runtime/mock-upstream.js'], {
            cwd: process.cwd(),
            env: { ...process.env, MOCK_UPSTREAM_PORT: String(port) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let startupTimeout;
        try {
            await Promise.race([
                once(child.stdout, 'data'),
                new Promise((_, reject) => {
                    startupTimeout = setTimeout(() => reject(new Error('mock upstream startup timeout')), 3000);
                })
            ]);
        } finally {
            clearTimeout(startupTimeout);
        }
    });

    afterAll(async () => {
        if (!child || child.exitCode !== null) return;
        child.kill();
        await once(child, 'exit');
    });

    test('serves deterministic unary, stream, image, and status responses', async () => {
        const unary = await fetch(`http://127.0.0.1:${port}/?mode=unary`);
        expect((await unary.json()).choices[0].message.content).toBe('ok');

        const stream = await fetch(`http://127.0.0.1:${port}/?mode=stream`);
        expect(await stream.text()).toMatch(/data: \[DONE\]/);

        const image = await fetch(`http://127.0.0.1:${port}/?mode=image&bytes=2048`);
        const imageBody = await image.json();
        expect(imageBody.data[0].b64_json.length).toBeGreaterThanOrEqual(2048);

        const limited = await fetch(`http://127.0.0.1:${port}/?status=429`);
        expect(limited.status).toBe(429);
    });
});
