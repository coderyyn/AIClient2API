export async function waitForCoordinationReady(coordination, { retryMs = 100, signal } = {}) {
    if (!coordination?.synchronize) return { ready: true };
    while (!signal?.aborted) {
        const state = await coordination.synchronize();
        if (state.ready) return state;
        await new Promise(resolve => setTimeout(resolve, retryMs));
    }
    const error = new Error('Coordination readiness wait aborted');
    error.code = 'COORDINATION_STARTUP_ABORTED';
    throw error;
}
