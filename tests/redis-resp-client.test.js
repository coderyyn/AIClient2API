import net from 'net';
import { RedisRespClient } from '../src/runtime/redis-resp-client.js';

function encode(value) {
    if (value === null) return '$-1\r\n';
    if (typeof value === 'number') return `:${value}\r\n`;
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

describe('RedisRespClient', () => {
    let server;
    let port;

    beforeAll(async () => {
        server = net.createServer(socket => {
            let buffer = Buffer.alloc(0);
            socket.on('data', chunk => {
                buffer = Buffer.concat([buffer, chunk]);
                const text = buffer.toString('utf8');
                if (!text.includes('\r\n')) return;
                if (text.includes('PING')) socket.write('+PONG\r\n');
                else if (text.includes('EVALSHA')) socket.write('-NOSCRIPT missing\r\n');
                else if (text.includes('EVAL')) socket.write(encode('{"ok":true}'));
                buffer = Buffer.alloc(0);
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => new Promise(resolve => server.close(resolve)));

    test('speaks RESP and falls back from EVALSHA to EVAL', async () => {
        const client = new RedisRespClient({ host: '127.0.0.1', port, connectTimeoutMs: 1000 });
        await expect(client.command(['PING'])).resolves.toBe('PONG');
        await expect(client.evalScript('test', 'return ARGV[1]', ['key'], ['value']))
            .resolves.toBe('{"ok":true}');
        await client.close();
    });
});
