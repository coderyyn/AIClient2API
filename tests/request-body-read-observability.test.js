import { EventEmitter } from 'node:events';
import { describe, expect, test } from '@jest/globals';
import { getRequestBody } from '../src/utils/common.js';
import requestContext from '../src/utils/context.js';
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';

function createRuntimeRequest() {
    const stages = [];
    const metadata = {};
    return {
        stages,
        metadata,
        mark: name => stages.push(name),
        setMetadata: update => Object.assign(metadata, update)
    };
}

function createRequest(contentLength) {
    const req = new EventEmitter();
    req.headers = { 'content-length': String(contentLength) };
    req.destroy = () => {};
    return req;
}

describe('request body read observability', () => {
    test('records the parsed stage and byte counts for a complete body', async () => {
        const runtimeRequest = createRuntimeRequest();
        const req = createRequest(15);
        const pending = requestContext.run({ runtimeRequest }, () => getRequestBody(req));
        req.emit('data', Buffer.from('{"model":"a"}'));
        req.emit('end');
        req.emit('close');

        await expect(pending).resolves.toEqual({ model: 'a' });
        expect(runtimeRequest.stages).toEqual(['bodyParsed']);
        expect(runtimeRequest.metadata).toMatchObject({
            requestBodyContentLength: 15,
            requestBodyReceivedBytes: 13,
            requestBodyComplete: true
        });
    });

    test('records an incomplete body when the client drops mid-upload', async () => {
        const runtimeRequest = createRuntimeRequest();
        const req = createRequest(1000);
        const pending = requestContext.run({ runtimeRequest }, () => getRequestBody(req));
        req.emit('data', Buffer.from('{"model":'));
        req.emit('error', new Error('aborted'));

        await expect(pending).rejects.toThrow('aborted');
        expect(runtimeRequest.stages).toEqual(['bodyAbortedMs']);
        expect(runtimeRequest.metadata).toMatchObject({
            requestBodyContentLength: 1000,
            requestBodyReceivedBytes: 9,
            requestBodyComplete: false
        });
    });

    test('exposes the body read state on the audit event', () => {
        const event = buildRequestAuditEvent({
            requestId: 'req-body',
            response: { httpStatus: 200, completed: false },
            runtime: {
                workerId: 'execution-1',
                stages: { bodyAbortedMs: 104000 },
                metadata: { requestBodyContentLength: 1000, requestBodyReceivedBytes: 9, requestBodyComplete: false }
            }
        });
        expect(event.runtime.requestBody).toEqual({ contentLength: 1000, receivedBytes: 9, complete: false });
    });
});
