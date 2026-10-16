const text = value => typeof value === 'string' ? value.trim() : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function safetyBufferingDifference(evidence = {}) {
    const signal = evidence.codexSafetyBuffering;
    const fasterModel = text(signal?.fasterModel);
    const outboundModel = text(evidence.outboundModel);
    const responseModel = text(evidence.upstreamResponseModel || evidence.responseModel);
    const compared = [outboundModel, responseModel].filter(Boolean);
    if (!fasterModel || !compared.some(model => model !== fasterModel)) return null;
    return { outboundModel, responseModel, fasterModel, enabled: typeof signal.enabled === 'boolean' ? signal.enabled : null };
}

export function safetyBufferingHtml(evidence, count = null) {
    const diff = safetyBufferingDifference(evidence);
    if (!diff) return '';
    return `<div class="reason-item safety-buffering-difference"><strong>响应头模型存在差异${count === null ? '' : `（${count} 次）`}</strong>
        <div>出站模型：${esc(diff.outboundModel || '未知')}</div>
        <div>响应体 model：${esc(diff.responseModel || '未知')}</div>
        <div>响应头 faster-model：${esc(diff.fasterModel)}</div>
        <div>安全缓冲 enabled：${diff.enabled === null ? '未知' : String(diff.enabled)}</div>
        <small class="muted">上游响应头信号，不代表独立验证的模型身份</small></div>`;
}

export function groupedSafetyBufferingHtml(probes = []) {
    const groups = new Map();
    for (const probe of probes) {
        const diff = safetyBufferingDifference(probe);
        if (!diff) continue;
        const key = JSON.stringify(diff);
        const group = groups.get(key) || { probe, count: 0 };
        group.count++;
        groups.set(key, group);
    }
    return [...groups.values()].map(({ probe, count }) => safetyBufferingHtml(probe, count)).join('');
}
