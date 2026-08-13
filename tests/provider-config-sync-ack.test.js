import { createProviderConfigAckTracker } from '../src/runtime/multi-worker-runtime.js';

describe('provider config synchronization acknowledgements', () => {
    test('reports pending workers until every execution worker acknowledges the revision', () => {
        const tracker = createProviderConfigAckTracker();
        tracker.notePublished(12, ['execution-1', 'execution-2']);
        expect(tracker.snapshot(['execution-1', 'execution-2'])).toMatchObject({ currentRevision: 12, pendingWorkerCount: 2 });
        tracker.acknowledge('execution-1', 12);
        expect(tracker.snapshot(['execution-1', 'execution-2'])).toMatchObject({ pendingWorkerCount: 1 });
        tracker.acknowledge('execution-2', 12);
        expect(tracker.snapshot(['execution-1', 'execution-2'])).toMatchObject({ pendingWorkerCount: 0 });
    });
});
