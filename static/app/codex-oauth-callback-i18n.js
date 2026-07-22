export const CODEX_OAUTH_CALLBACK_TRANSLATIONS = Object.freeze({
    'zh-CN': Object.freeze({
        'oauth.codex.callback.successTitle': 'Codex OAuth 回调已接收',
        'oauth.codex.callback.errorTitle': 'Codex OAuth 授权失败',
        'oauth.codex.callback.successHeading': '✅ 回调已接收',
        'oauth.codex.callback.errorHeading': '❌ 授权失败',
        'oauth.codex.callback.successMessage': '授权回调已提交，正在完成凭据更新。',
        'oauth.codex.callback.errorMessage': '授权未完成，请返回管理页面重试。',
        'oauth.codex.callback.savingHint': '凭据正在后台完成保存，请返回管理页面查看最终结果。',
        'oauth.codex.callback.closeHint': '如果浏览器没有自动关闭此页，请手动关闭。',
        'oauth.codex.callback.closeButton': '关闭此页'
    }),
    'en-US': Object.freeze({
        'oauth.codex.callback.successTitle': 'Codex OAuth callback received',
        'oauth.codex.callback.errorTitle': 'Codex OAuth authorization failed',
        'oauth.codex.callback.successHeading': '✅ Callback received',
        'oauth.codex.callback.errorHeading': '❌ Authorization failed',
        'oauth.codex.callback.successMessage': 'The authorization callback was submitted. Credential update is in progress.',
        'oauth.codex.callback.errorMessage': 'Authorization did not complete. Return to the management page and try again.',
        'oauth.codex.callback.savingHint': 'Credentials are being saved in the background. Return to the management page for the final result.',
        'oauth.codex.callback.closeHint': 'If this page does not close automatically, close it manually.',
        'oauth.codex.callback.closeButton': 'Close this page'
    })
});

export function resolveCodexOAuthCallbackLocale(locale = '') {
    return String(locale).toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export function getCodexOAuthCallbackTranslations(locale = '') {
    return CODEX_OAUTH_CALLBACK_TRANSLATIONS[resolveCodexOAuthCallbackLocale(locale)];
}
