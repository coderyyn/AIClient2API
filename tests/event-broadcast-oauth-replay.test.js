import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

import { broadcastEvent, handleEvents } from '../src/ui-modules/event-broadcast.js';

function createRequest(lastEventId = null) {
    const closeHandlers = [];
    return {
        headers: lastEventId === null ? {} : { 'last-event-id': String(lastEventId) },
        on: jest.fn((event, handler) => {
            if (event === 'close') closeHandlers.push(handler);
        }),
        close() {
            closeHandlers.forEach(handler => handler());
        }
    };
}

function createResponse() {
    const writes = [];
    return {
        writes,
        writableEnded: false,
        destroyed: false,
        writeHead: jest.fn(),
        write: jest.fn(chunk => {
            writes.push(String(chunk));
            return true;
        })
    };
}

beforeEach(() => {
    global.eventClients = [];
    global.eventSequence = 0;
    global.eventReplayBuffer = [];
});

describe('OAuth SSE terminal event replay', () => {
    test('replays a missed OAuth terminal event after EventSource reconnects', async () => {
        const initialRequest = createRequest();
        const initialResponse = createResponse();
        await handleEvents(initialRequest, initialResponse);
        const initialOutput = initialResponse.writes.join('');
        initialRequest.close();

        expect(initialOutput).toContain('event: stream_ready');
        expect(initialOutput).toContain('id: 0');

        broadcastEvent('oauth_success', {
            provider: 'openai-codex-oauth',
            sessionId: 'session-replay'
        });

        const reconnectRequest = createRequest(0);
        const reconnectResponse = createResponse();
        await handleEvents(reconnectRequest, reconnectResponse);
        const replayed = reconnectResponse.writes.join('');
        reconnectRequest.close();

        expect(replayed).toContain('id: 1');
        expect(replayed).toContain('event: oauth_success');
        expect(replayed).toContain('session-replay');
    });

    test('does not replay stale OAuth events to a brand-new EventSource connection', async () => {
        broadcastEvent('oauth_error', {
            provider: 'openai-codex-oauth',
            sessionId: 'stale-session'
        });

        const request = createRequest();
        const response = createResponse();
        await handleEvents(request, response);
        const output = response.writes.join('');
        request.close();

        expect(output).toContain('event: stream_ready');
        expect(output).not.toContain('event: oauth_error');
        expect(output).not.toContain('stale-session');
    });

    test('does not replay terminal events for OAuth providers without strict session matching', async () => {
        const initialRequest = createRequest();
        const initialResponse = createResponse();
        await handleEvents(initialRequest, initialResponse);
        initialRequest.close();

        broadcastEvent('oauth_success', {
            provider: 'gemini-cli-oauth'
        });

        const reconnectRequest = createRequest(0);
        const reconnectResponse = createResponse();
        await handleEvents(reconnectRequest, reconnectResponse);
        const output = reconnectResponse.writes.join('');
        reconnectRequest.close();

        expect(output).not.toContain('event: oauth_success');
        expect(output).not.toContain('gemini-cli-oauth');
    });
});
