import crypto from 'crypto';

export const CODEX_FINGERPRINT_MODES = Object.freeze(['off', 'device', 'session', 'full']);
// 默认不改写；需要收敛的凭据显式选择模式（对齐 sub2api #5668 的 opt-in 结论）。
export const DEFAULT_CODEX_FINGERPRINT_MODE = 'off';
export const CODEX_FINGERPRINT_VERSION = 1;
export const CODEX_FINGERPRINT_CONTEXT_KEY = '_codexFingerprintContext';

// 非 v7 来源 ID 无法继承真实时间戳时，在该窗口内取确定性时间，保证同一来源每次派生结果一致。
const FALLBACK_TIMESTAMP_BASE_MS = Date.UTC(2026, 0, 1);
const FALLBACK_TIMESTAMP_RANGE_MS = 180 * 24 * 60 * 60 * 1000;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCodexOAuthProvider(providerConfig = {}) {
    const providerType = providerConfig.MODEL_PROVIDER || providerConfig.type || providerConfig.providerType;
    return providerType === 'openai-codex-oauth' || String(providerType || '').startsWith('openai-codex-oauth-');
}

function sha256(seed) {
    return crypto.createHash('sha256').update(String(seed)).digest();
}

function formatUuid(bytes) {
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 原生 installation_id 是 UUIDv4（~/.codex/installation_id）。
function stableUuidV4(seed) {
    const bytes = Buffer.from(sha256(seed).subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
}

function uuidV7FromParts(timestampMs, randomBytes) {
    const bytes = Buffer.from(randomBytes.subarray(0, 16));
    bytes.writeUIntBE(Math.max(0, Math.floor(timestampMs)) % 2 ** 48, 0, 6);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
}

function uuidV7Timestamp(value) {
    const normalized = String(value || '').trim();
    return UUID_V7_PATTERN.test(normalized) ? parseInt(normalized.replace(/-/g, '').slice(0, 12), 16) : null;
}

// 原生 thread/session/turn ID 是 UUIDv7（codex-rs ThreadId/SessionId::new 与 turn_id 均为 Uuid::now_v7）。
// 来源本身是 v7 时继承其时间戳，派生 ID 的时间与真实会话一致。
function stableUuidV7(seed, sourceId = '') {
    const timestamp = uuidV7Timestamp(sourceId)
        ?? FALLBACK_TIMESTAMP_BASE_MS + sha256(`${seed}:timestamp`).readUInt32BE(0) % FALLBACK_TIMESTAMP_RANGE_MS;
    return uuidV7FromParts(timestamp, sha256(seed));
}

function randomUuidV7() {
    return uuidV7FromParts(Date.now(), crypto.randomBytes(16));
}

function accountSeed(providerConfig = {}) {
    return String(
        providerConfig.codexAccountKey ||
        providerConfig.codexAccountId ||
        providerConfig.uuid ||
        ''
    ).trim();
}

function rewriteJsonString(value, fields) {
    if (typeof value !== 'string' || !value.trim()) return value;
    try {
        return JSON.stringify({ ...JSON.parse(value), ...fields });
    } catch {
        return value;
    }
}

function deleteHeaderCaseInsensitive(headers, name) {
    const normalized = String(name).toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === normalized) delete headers[key];
    }
}

export function resolveCodexFingerprintMode(providerConfig = {}) {
    if (!isCodexOAuthProvider(providerConfig)) return 'off';
    const configured = String(providerConfig.codexFingerprintMode || '').trim().toLowerCase();
    return CODEX_FINGERPRINT_MODES.includes(configured) ? configured : DEFAULT_CODEX_FINGERPRINT_MODE;
}

export function extractOriginalCodexSessionId(headers = {}, requestBody = {}) {
    const getHeader = (name) => headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
    const clientMetadata = requestBody?.client_metadata || {};
    const requestMetadata = requestBody?.metadata || {};
    return [
        getHeader('session-id'),
        getHeader('session_id'),
        requestBody?.session_id,
        clientMetadata.session_id,
        requestMetadata.session_id
    ].find(value => value !== undefined && value !== null && String(value).trim())?.toString().trim() || '';
}

// 原生 x-codex-window-id 为 `<thread_id>:<window_number>`，压缩后 window_number 递增。
export function extractOriginalCodexWindowNumber(headers = {}, requestBody = {}) {
    const headerEntry = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'x-codex-window-id');
    const value = headerEntry?.[1] ?? requestBody?.client_metadata?.['x-codex-window-id'];
    const match = /:(\d+)$/.exec(String(value || '').trim());
    return match ? Number(match[1]) : 0;
}

function bindConversation(ids, seed, conversationKey) {
    const key = String(conversationKey || '').trim();
    // 原生根会话 session_id == thread_id；full 模式整个账号只用一个会话。
    const threadId = ids.mode === 'full' || !key
        ? stableUuidV7(`aiclient2api:codex-session:v${CODEX_FINGERPRINT_VERSION}:${seed}`)
        : stableUuidV7(`aiclient2api:codex-thread:v${CODEX_FINGERPRINT_VERSION}:${seed}:${key}`, key);
    ids.sessionId = threadId;
    ids.threadId = threadId;
    ids.windowId = `${threadId}:${ids.windowNumber}`;
    ids.conversationBound = Boolean(key) || ids.mode === 'full';
    return ids;
}

export function resolveCodexFingerprintIds({
    providerConfig = {},
    originalClientSessionId = '',
    originalTurnId = '',
    originalRootTurnId = '',
    windowNumber = 0
} = {}) {
    const mode = resolveCodexFingerprintMode(providerConfig);
    if (mode === 'off') return null;
    const seed = accountSeed(providerConfig);
    if (!seed) return null;

    const installationId = stableUuidV4(`aiclient2api:codex-installation:v${CODEX_FINGERPRINT_VERSION}:${seed}`);
    if (mode === 'device') {
        return { mode, version: CODEX_FINGERPRINT_VERSION, installationId, sessionId: null, threadId: null, turnId: null, windowId: null };
    }

    const deriveTurn = (sourceTurnId) => stableUuidV7(
        `aiclient2api:codex-turn:v${CODEX_FINGERPRINT_VERSION}:${seed}:${sourceTurnId}`,
        sourceTurnId
    );
    const sourceTurnId = String(originalTurnId || '').trim();
    const sourceRootTurnId = String(originalRootTurnId || '').trim();
    const turnId = sourceTurnId ? deriveTurn(sourceTurnId) : randomUuidV7();
    // 根轮次 root_turn_id == turn_id；子代理轮次按同一规则映射，保持父子关系。
    const rootTurnId = sourceRootTurnId && sourceRootTurnId !== sourceTurnId ? deriveTurn(sourceRootTurnId) : turnId;
    const ids = {
        mode,
        version: CODEX_FINGERPRINT_VERSION,
        installationId,
        turnId,
        rootTurnId,
        windowNumber: Number.isInteger(windowNumber) && windowNumber >= 0 ? windowNumber : 0,
        turnStartedAtUnixMs: Date.now()
    };
    return bindConversation(ids, seed, originalClientSessionId);
}

// 客户端未带会话 ID 时，用最终的 prompt_cache_key 作为会话键重新绑定，并让 prompt_cache_key
// 与 session-id 保持一致（原生 Codex 根会话 prompt_cache_key == session_id）。
export function bindCodexFingerprintConversation(ids, providerConfig = {}, conversationKey = '') {
    if (!ids || ids.mode === 'device') return ids;
    if (!ids.conversationBound) {
        bindConversation(ids, accountSeed(providerConfig), conversationKey);
    }
    return ids;
}

export function applyCodexFingerprintHeaders(headers = {}, ids) {
    if (!ids) return false;
    const rewrittenHeaderNames = ids.mode === 'device'
        ? ['x-codex-installation-id']
        : [
            'x-codex-installation-id', 'x-codex-window-id', 'x-client-request-id',
            'session-id', 'session_id', 'thread-id'
        ];
    for (const name of rewrittenHeaderNames) {
        deleteHeaderCaseInsensitive(headers, name);
    }
    // 原生 Codex 不以请求头发送 installation id，只放在 client_metadata 与 turn-metadata 中。

    const metadataFields = { installation_id: ids.installationId };
    if (ids.mode !== 'device') {
        headers['x-codex-window-id'] = ids.windowId;
        headers['x-client-request-id'] = ids.threadId;
        headers['session-id'] = ids.sessionId;
        headers['thread-id'] = ids.threadId;
        Object.assign(metadataFields, {
            session_id: ids.sessionId,
            thread_id: ids.threadId,
            turn_id: ids.turnId,
            root_turn_id: ids.rootTurnId,
            window_id: ids.windowId,
            turn_started_at_unix_ms: ids.turnStartedAtUnixMs
        });
    }
    if (Object.prototype.hasOwnProperty.call(headers, 'x-codex-turn-metadata')) {
        headers['x-codex-turn-metadata'] = rewriteJsonString(headers['x-codex-turn-metadata'], metadataFields);
    }
    return true;
}

export function applyCodexFingerprintClientMetadata(requestBody = {}, ids) {
    if (!ids) return false;
    const originalClientMetadata = requestBody.client_metadata;
    const clientMetadata = originalClientMetadata && typeof originalClientMetadata === 'object'
        ? { ...originalClientMetadata }
        : {};
    clientMetadata['x-codex-installation-id'] = ids.installationId;

    const metadataFields = { installation_id: ids.installationId };
    if (ids.mode !== 'device') {
        Object.assign(clientMetadata, {
            session_id: ids.sessionId,
            thread_id: ids.threadId,
            turn_id: ids.turnId,
            root_turn_id: ids.rootTurnId,
            'x-codex-window-id': ids.windowId
        });
        Object.assign(metadataFields, {
            session_id: ids.sessionId,
            thread_id: ids.threadId,
            turn_id: ids.turnId,
            root_turn_id: ids.rootTurnId,
            window_id: ids.windowId,
            turn_started_at_unix_ms: ids.turnStartedAtUnixMs
        });
    }
    if (Object.prototype.hasOwnProperty.call(clientMetadata, 'x-codex-turn-metadata')) {
        clientMetadata['x-codex-turn-metadata'] = rewriteJsonString(clientMetadata['x-codex-turn-metadata'], metadataFields);
    }
    requestBody.client_metadata = clientMetadata;
    return true;
}
