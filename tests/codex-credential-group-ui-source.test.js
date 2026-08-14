import fs from 'fs';
import path from 'path';

function readSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('Codex credential-group UI source', () => {
    const providersHtml = readSource('static/components/section-providers.html');
    const providerManager = readSource('static/app/provider-manager.js');
    const potluckHtml = readSource('static/potluck.html');

    test('keeps the original Providers view as the default and exposes an accessible advanced-view toggle', () => {
        expect(providersHtml).toContain('id="providersViewToggleBtn"');
        expect(providersHtml).toContain('aria-expanded="false"');
        expect(providersHtml).toContain('aria-controls="credentialGroupsPanel"');
        expect(providersHtml).toContain('id="providersDefaultView"');
        expect(providersHtml).toMatch(/id="credentialGroupsPanel"[^>]*hidden/);
        expect(providerManager).toContain('setProvidersAdvancedView');
        expect(providerManager).not.toMatch(/Promise\.all\(\[\s*loadProviders\(forceRefreshSupported\),\s*loadCredentialGroupManagement\(\)/);
    });

    test('Providers page exposes the relationship-management panel and its primary containers', () => {
        [
            'credentialGroupsPanel',
            'credentialGroupsRefreshBtn',
            'credentialGroupsRollbackBtn',
            'credentialGroupsPreviewBtn',
            'credentialGroupsStatus',
            'credentialGroupsContent',
            'credentialGroupsPreview',
            'credentialGroupsCurrentGroups',
            'credentialGroupsCredentials',
            'credentialGroupsKeys',
            'credentialGroupsRevisions'
        ].forEach(id => expect(providersHtml).toContain(`id="${id}"`));
    });

    test('uses the apiClient relative paths so the client adds the /api prefix exactly once', () => {
        [
            '/potluck/credential-groups',
            '/potluck/credential-groups/preview',
            '/potluck/credential-groups/apply',
            '/potluck/credential-groups/revisions',
            '/potluck/credential-groups/rollback'
        ].forEach(endpoint => expect(providerManager).toContain(endpoint));

        expect(providerManager).not.toContain("'/api/potluck/credential-groups");
    });

    test('requires confirmation for apply and rollback and sends the current revision for rollback', () => {
        expect(providerManager).toContain("window.confirm(t('providers.credentialGroups.applyConfirm'))");
        expect(providerManager).toContain("window.confirm(t('providers.credentialGroups.rollbackConfirm'))");
        expect(providerManager).toContain('options.allowWhileBusy !== true');
        expect(providerManager).toContain("statusKey: 'refreshing', allowWhileBusy: true");
        expect(providerManager).toMatch(
            /post\('\/potluck\/credential-groups\/rollback',\s*\{\s*baseRevision:\s*credentialGroupView\.revision\s*\}\)/
        );
    });

    test('clears an old preview when the preview is missing, expired, or based on a stale revision', () => {
        expect(providerManager).toContain(
            "['PREVIEW_NOT_FOUND', 'PREVIEW_EXPIRED', 'CREDENTIAL_GROUP_REVISION_CONFLICT'].includes(code)"
        );
        expect(providerManager).toContain("if (code === 'CREDENTIAL_GROUP_REVISION_CONFLICT') {");
        expect(providerManager).toContain('clearCredentialGroupPreview();');
    });

    test('renders only public credential references and escapes dynamic management data', () => {
        expect(providerManager).toContain('credential.credentialRef');
        expect(providerManager).toContain('key?.maskedKey || key?.keyRef');
        expect(providerManager).toContain('escapeHtml(credential.credentialRef');
        expect(providerManager).toContain('escapeHtml(primaryGroup)');
        expect(providerManager).not.toContain('fixedCredential.uuid');
        expect(providerManager).not.toContain('credential.uuid');
    });

    test('shows a compact safe Potluck routing badge beside the key-name editor', () => {
        const helperStart = potluckHtml.indexOf('function renderKeyRoutingSummary');
        const helperEnd = potluckHtml.indexOf('function renderKeys', helperStart);
        expect(helperStart).toBeGreaterThanOrEqual(0);
        expect(helperEnd).toBeGreaterThan(helperStart);

        const helper = potluckHtml.slice(helperStart, helperEnd);
        expect(helper).toContain('key?.routingMode');
        expect(helper).toContain('key?.primaryGroupId');
        expect(helper).toContain('key?.manualLock');
        expect(helper).toContain("replace(/^group-/i, '')");
        expect(helper).toContain("compactGroup ? `${compactGroup} · auto` : 'auto'");
        expect(helper).not.toContain("compactGroup = primaryGroupId ? primaryGroupId.replace(/^group-/i, '') : '?'");
        expect(helper).toContain('fixed');
        expect(helper).toContain('auto');
        expect(helper).toContain('固定凭据 · 禁止降级');
        expect(helper).toContain('不可用时跨组降级');
        expect(helper).toContain('手工锁定');
        expect(helper).toContain('aria-label=');
        expect(helper).toContain('title=');
        expect(helper).not.toContain('fixedCredential.uuid');
        expect(helper).not.toContain('key.id');

        const keyNameLine = potluckHtml.match(/<div class="key-name">[^\n]+/u)?.[0] || '';
        expect(keyNameLine).toContain('renderKeyRoutingSummary(key)');
        expect(potluckHtml).not.toMatch(/<div class="key-id">[^\n]+<\/div>\s*\$\{renderKeyRoutingSummary\(key\)\}/u);
    });
});
