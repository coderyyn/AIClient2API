export function isExpectedCodexOAuthCallbackMessage(event, context = {}) {
    const data = event?.data;
    if (!data || data.type !== 'codex-oauth-callback-received') return false;
    if (event.source !== context.authWindow) return false;
    if (!context.expectedCallbackOrigin || event.origin !== context.expectedCallbackOrigin) return false;
    if (data.provider !== context.provider) return false;
    if (data.sessionId !== context.sessionId) return false;
    return true;
}

export function isExpectedOAuthPopupCompleteMessage(event, context = {}) {
    const data = event?.data;
    if (!data || data.type !== 'oauth-popup-complete') return false;
    if (!context.authWindow || event.source !== context.authWindow) return false;
    if (!context.expectedOrigin || event.origin !== context.expectedOrigin) return false;
    if (data.provider && data.provider !== context.provider) return false;
    return true;
}

export function createOAuthPopupSession(options = {}) {
    const eventTarget = options.eventTarget;
    if (!eventTarget?.addEventListener || !eventTarget?.removeEventListener) {
        throw new TypeError('OAuth popup session requires an event target');
    }

    const setIntervalFn = options.setIntervalFn || globalThis.setInterval.bind(globalThis);
    const clearIntervalFn = options.clearIntervalFn || globalThis.clearInterval.bind(globalThis);
    const setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
    const clearTimeoutFn = options.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
    const listenerTimeoutMs = options.listenerTimeoutMs ?? (5 * 60 * 1000);
    const armTimeoutOnRegister = options.armTimeoutOnRegister !== false;
    const listeners = [
        ['oauth_success_event', options.onSuccess],
        ['oauth_error_event', options.onError],
        ['message', options.onMessage]
    ].filter(([, handler]) => typeof handler === 'function');

    let authWindow = null;
    let pollTimer = null;
    let listenerTimeout = null;
    let listenersRegistered = false;

    const stopPopupPolling = () => {
        if (pollTimer !== null) {
            clearIntervalFn(pollTimer);
            pollTimer = null;
        }
    };

    const stopListenerTimeout = () => {
        if (listenerTimeout !== null) {
            clearTimeoutFn(listenerTimeout);
            listenerTimeout = null;
        }
    };

    const armListenerTimeout = (timeoutMs = listenerTimeoutMs) => {
        stopListenerTimeout();
        if (timeoutMs <= 0) return;
        listenerTimeout = setTimeoutFn(() => {
            listenerTimeout = null;
            cleanupListeners();
            options.onTimeout?.();
        }, timeoutMs);
    };

    const cleanupListeners = () => {
        stopPopupPolling();
        stopListenerTimeout();
        if (!listenersRegistered) return;
        listeners.forEach(([type, handler]) => eventTarget.removeEventListener(type, handler));
        listenersRegistered = false;
    };

    const registerListeners = () => {
        if (listenersRegistered) return false;
        listeners.forEach(([type, handler]) => eventTarget.addEventListener(type, handler));
        listenersRegistered = true;
        if (armTimeoutOnRegister) armListenerTimeout();
        return true;
    };

    const setAuthWindow = (nextWindow) => {
        authWindow = nextWindow || null;
    };

    const closeAuthWindow = () => {
        const popup = authWindow;
        authWindow = null;
        if (!popup) return;
        try {
            popup.close();
        } catch (error) {
            options.onCloseError?.(error);
        }
    };

    const startPopupPolling = (poll, intervalMs = 1000) => {
        stopPopupPolling();
        pollTimer = setIntervalFn(() => poll(authWindow), intervalMs);
    };

    const dispose = ({ closeWindow = true } = {}) => {
        cleanupListeners();
        if (closeWindow) {
            closeAuthWindow();
        } else {
            authWindow = null;
        }
    };

    return {
        registerListeners,
        cleanupListeners,
        armListenerTimeout,
        stopListenerTimeout,
        startPopupPolling,
        stopPopupPolling,
        setAuthWindow,
        getAuthWindow: () => authWindow,
        closeAuthWindow,
        dispose,
        isListening: () => listenersRegistered
    };
}
