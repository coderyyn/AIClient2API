import http from 'http';

const port = Number(process.env.MOCK_UPSTREAM_PORT || 3901);
const pixel = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex').toString('base64');

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const delay = Math.max(0, Number(url.searchParams.get('delay') || 0));
    const mode = url.searchParams.get('mode') || 'unary';
    const status = Number(url.searchParams.get('status') || 200);
    await new Promise(resolve => setTimeout(resolve, delay));
    if (mode === 'disconnect') return req.socket.destroy();
    res.writeHead(status, { 'Content-Type': mode === 'stream' ? 'text/event-stream' : 'application/json' });
    if (mode === 'stream') {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
    }
    if (mode === 'image') {
        const targetBytes = Math.max(pixel.length, Number(url.searchParams.get('bytes') || pixel.length));
        return res.end(JSON.stringify({ data: [{ b64_json: pixel.padEnd(targetBytes, 'A') }] }));
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`mock-upstream:${port}\n`));

