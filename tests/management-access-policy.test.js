import { isPublicBusinessPath, requiresManagementAuthentication, isOnlinePluginInstallPath } from '../src/utils/management-access-policy.js';

test.each(['/v1/responses', '/openai-codex-oauth/v1/images/edits', '/gemini-antigravity/v1beta/models/gemini:streamGenerateContent'])('model path %s stays public to business authentication', path => {
    expect(isPublicBusinessPath('POST', path)).toBe(true);
    expect(requiresManagementAuthentication('POST', path)).toBe(false);
});
test.each(['/api/potluck/keys', '/api/request-audit', '/runtime/health', '/provider_health', '/api/grok/assets', '/api/new-sensitive-api', '/v1/responses/../../api/config', '/api/%ZZ'])('sensitive or malformed path %s is not public', path => {
    expect(isPublicBusinessPath('GET', path)).toBe(false);
});
test('user usage is an exact GET exception, not a management prefix exemption', () => {
    expect(isPublicBusinessPath('GET', '/api/potluckuser/usage')).toBe(true);
    expect(isPublicBusinessPath('POST', '/api/potluckuser/usage')).toBe(false);
    expect(isPublicBusinessPath('GET', '/api/potluckuser/usage/keys')).toBe(false);
    expect(isPublicBusinessPath('GET', '/app/plugin-manager.js')).toBe(false);
    expect(isPublicBusinessPath('GET', '/app/base.css')).toBe(true);
});
test.each(['/api/plugins/upload', '/api/plugins/install/', '/api/plugins/%75pload', '/api//plugins/upload'])('installation alias %s is recognized', path => {
    expect(isOnlinePluginInstallPath(path)).toBe(true);
});
