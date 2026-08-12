export function compareRuntimeReports(baseline, candidate, options = {}) {
    const maxP95Ratio = Number(options.maxP95Ratio ?? 1.05);
    const failures = [];
    if (Number(candidate.throughput) < Number(baseline.throughput)) {
        failures.push(`throughput regressed: ${candidate.throughput} < ${baseline.throughput}`);
    }
    if (Number(candidate.errorRate) > Number(baseline.errorRate)) {
        failures.push(`error rate regressed: ${candidate.errorRate} > ${baseline.errorRate}`);
    }
    if (Number(candidate.latency?.p95) > Number(baseline.latency?.p95) * maxP95Ratio) {
        failures.push(`p95 regressed beyond ${Math.round((maxP95Ratio - 1) * 100)}% allowance`);
    }
    return { passed: failures.length === 0, failures };
}

