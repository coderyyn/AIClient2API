import logger from '../../utils/logger.js';
import { buildDiagnostics } from './cache-diagnostics.js';

export async function runRequestAuditAnalyzer({
    auditStore,
    analysisStore,
    lookbackMinutes = 180,
    maxEvents = 5000,
    generatedAt = new Date().toISOString()
} = {}) {
    if (!auditStore || !analysisStore) return { diagnosticsCount: 0 };
    const until = new Date(generatedAt);
    const since = new Date(until.getTime() - Number(lookbackMinutes || 180) * 60 * 1000);
    const events = await auditStore.query({
        since: since.toISOString(),
        until: until.toISOString(),
        limit: Number(maxEvents || 5000)
    });
    const diagnostics = buildDiagnostics(events);
    await analysisStore.writeDiagnostics(diagnostics, { generatedAt });
    return { diagnosticsCount: diagnostics.length };
}

export function createRequestAuditAnalyzerRunner({
    auditStore,
    analysisStore,
    intervalMs = 60000,
    lookbackMinutes = 180,
    maxEvents = 5000,
    runOnInit = false
} = {}) {
    let timer = null;
    let inFlight = false;

    const run = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
            await runRequestAuditAnalyzer({ auditStore, analysisStore, lookbackMinutes, maxEvents });
        } catch (error) {
            logger.warn('[Request Audit] Analyzer failed:', error.message);
        } finally {
            inFlight = false;
        }
    };

    const start = () => {
        if (timer) clearInterval(timer);
        timer = setInterval(run, Number(intervalMs || 60000));
        timer.unref?.();
        if (runOnInit) setImmediate(run);
    };

    const stop = () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    };

    return { start, stop, run };
}
