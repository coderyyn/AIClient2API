import { EventEmitter } from 'events';
import { instrumentResponseForAudit } from '../src/utils/request-audit-lifecycle.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.writableFinished = false;
    this.writableEnded = false;
  }

  writeHead(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  write() {
    return true;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') callback = chunk;
    if (typeof encoding === 'function') callback = encoding;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
    callback?.();
    return this;
  }
}

describe('request audit response lifecycle', () => {
  test('counts response bytes without treating an end callback as response content', async () => {
    const completed = jest.fn();
    const res = new FakeResponse();
    const lifecycle = instrumentResponseForAudit(res, completed);
    lifecycle.markEligible();
    lifecycle.setNormalizedPath('/v1/chat/completions');

    res.write('hello');
    res.end(() => {});
    await new Promise(resolve => setImmediate(resolve));

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toMatchObject({
      normalizedPath: '/v1/chat/completions',
      response: { httpStatus: 200, bytes: 5, completed: true, clientAborted: false }
    });
  });

  test('classifies a premature close as client aborted and finalizes once', async () => {
    const completed = jest.fn();
    const res = new FakeResponse();
    const lifecycle = instrumentResponseForAudit(res, completed);
    lifecycle.markEligible();

    res.write('partial');
    res.emit('close');
    res.emit('error', new Error('socket closed'));
    await new Promise(resolve => setImmediate(resolve));

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0].response).toMatchObject({
      bytes: 7,
      completed: false,
      clientAborted: true
    });
  });

  test('keeps client aborted precedence when delayed finalization also observes a response error', async () => {
    const completed = jest.fn();
    const res = new FakeResponse();
    const lifecycle = instrumentResponseForAudit(res, completed, { autoFinalize: false });
    lifecycle.markEligible();

    res.emit('close');
    res.emit('error', new Error('socket closed'));
    await lifecycle.complete();

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toMatchObject({
      errorClass: 'client_aborted',
      response: { completed: false, clientAborted: true }
    });
  });
});
