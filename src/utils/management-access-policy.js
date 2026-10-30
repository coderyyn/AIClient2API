// Shared, fail-closed classification. IP admission belongs to the trusted ingress;
// workers still authenticate management APIs before any plugin can handle them.
export function normalizeAccessPath(rawPath) {
    try {
        const path = decodeURIComponent(String(rawPath).split('?')[0]);
        if (path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '.' || p === '..')) return null;
        return path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    } catch { return null; }
}

export function isPublicBusinessPath(method, rawPath) {
    const path = normalizeAccessPath(rawPath);
    if (!path) return false;
    if (['GET', 'HEAD'].includes(method) && ['/health', '/potluck-user.html', '/app/base.css', '/favicon.ico'].includes(path)) return true;
    if (['GET', 'OPTIONS'].includes(method) && path === '/api/potluckuser/usage') return true;
    return ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(method) && (
        /^\/(?:[^/]+\/)?v1\/(?:chat\/completions|responses|messages(?:\/count_tokens)?|models|images\/(?:generations|edits))$/.test(path)
        || /^\/(?:[^/]+\/)?v1beta\/models(?:\/[^/]+(?::[^/]+)?)?$/.test(path)
    );
}

export function isOnlinePluginInstallPath(rawPath) {
    const path = normalizeAccessPath(rawPath);
    return path === '/api/plugins/upload' || path === '/api/plugins/install';
}

export function requiresManagementAuthentication(method, rawPath) {
    const path = normalizeAccessPath(rawPath);
    if (!path) return true;
    if (path === '/api/login') return false;
    if (isPublicBusinessPath(method, path)) return false;
    return path.startsWith('/api/') || path === '/provider_health';
}

export function rejectOnlinePluginInstall(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'PLUGIN_INSTALL_DISABLED', message: 'Online plugin installation is disabled; deploy reviewed plugins with the application.' } }));
    return true;
}

export function onlinePluginInstallationEnabled() {
    return process.env.PLUGIN_INSTALL_ENABLED === 'true';
}
