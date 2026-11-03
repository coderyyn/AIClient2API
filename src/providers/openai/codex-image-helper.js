import { getProviderModels } from '../provider-models.js';

export const DEFAULT_CODEX_IMAGE_HELPER_MODEL = 'gpt-6-luna';

export function normalizeCodexImageHelperModel(value) {
    if (value == null) return '';
    const model = typeof value === 'string' ? value.trim() : null;
    if (model === '') return '';
    if (model && !/^gpt-image(?:-|$)/i.test(model)
        && !/-(?:fast|ultrafast)$/i.test(model)
        && getProviderModels('openai-codex-oauth').includes(model)) {
        return model;
    }
    const error = new Error('CODEX_IMAGE_HELPER_MODEL must be a supported Codex text base model. / 生图辅助主模型必须是支持的 Codex 文本基础模型。');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'invalid_image_helper_model';
    error.skipErrorCount = true;
    error.shouldSwitchCredential = false;
    throw error;
}

// Resolve before the generic provider merge so an empty node field inherits the global value.
export function resolveCodexImageHelperModel(globalConfig = {}, nodeConfig = {}) {
    for (const config of [nodeConfig, globalConfig]) {
        const value = config.CODEX_IMAGE_HELPER_MODEL;
        if (value == null || (typeof value === 'string' && !value.trim())) continue;
        return value;
    }
    return DEFAULT_CODEX_IMAGE_HELPER_MODEL;
}
