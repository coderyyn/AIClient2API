import { getCodexOAuthCallbackTranslations, resolveCodexOAuthCallbackLocale } from '../../static/app/codex-oauth-callback-i18n.js';

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function serializeForInlineScript(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function generateCodexCallbackPage({ isSuccess, message = '', sessionId = '', locale = 'zh-CN' } = {}) {
    const copy = getCodexOAuthCallbackTranslations(locale);
    const htmlLang = resolveCodexOAuthCallbackLocale(locale);
    const safeMessage = escapeHtml(message || copy[isSuccess
        ? 'oauth.codex.callback.successMessage'
        : 'oauth.codex.callback.errorMessage']);
    const title = copy[isSuccess
        ? 'oauth.codex.callback.successTitle'
        : 'oauth.codex.callback.errorTitle'];
    const heading = copy[isSuccess
        ? 'oauth.codex.callback.successHeading'
        : 'oauth.codex.callback.errorHeading'];
    const headingColor = isSuccess ? '#047857' : '#b91c1c';
    const callbackPayload = serializeForInlineScript({
        type: 'codex-oauth-callback-received',
        provider: 'openai-codex-oauth',
        sessionId
    });
    const closeScript = isSuccess ? `
        <script>
            (() => {
                const payload = ${callbackPayload};
                const manualButton = document.getElementById('manual-close-button');
                const closeHint = document.getElementById('close-hint');
                let closeAttempts = 0;
                const maxCloseAttempts = 5;

                const notifyOpener = () => {
                    try {
                        if (window.opener) {
                            window.opener.postMessage(payload, '*');
                        }
                    } catch (error) {}
                };

                const attemptClose = () => {
                    closeAttempts += 1;
                    try {
                        window.close();
                    } catch (error) {}

                    if (closeAttempts >= maxCloseAttempts) {
                        clearInterval(closeTimer);
                        if (manualButton) manualButton.hidden = false;
                        if (closeHint) closeHint.hidden = false;
                    }
                };

                notifyOpener();
                setTimeout(attemptClose, 1000);
                const closeTimer = setInterval(attemptClose, 1000);
            })();
        </script>
    ` : '';

    return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 48px 20px; color: #374151; }
        main { max-width: 560px; margin: 0 auto; }
        h1 { color: ${headingColor}; }
        p { line-height: 1.6; }
        button { margin-top: 16px; padding: 10px 18px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
    </style>
</head>
<body>
    <main>
        <h1>${heading}</h1>
        <p>${safeMessage}</p>
        ${isSuccess ? `<p>${copy['oauth.codex.callback.savingHint']}</p>` : ''}
        <p id="close-hint" ${isSuccess ? 'hidden' : ''}>${copy['oauth.codex.callback.closeHint']}</p>
        <button id="manual-close-button" type="button" onclick="window.close()" ${isSuccess ? 'hidden' : ''}>${copy['oauth.codex.callback.closeButton']}</button>
    </main>
    ${closeScript}
</body>
</html>`;
}
