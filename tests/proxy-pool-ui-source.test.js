import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('provider proxy pool UI source', () => {
    test('provider fields render PROXY_ID as proxy pool select instead of free text', () => {
        const utilsSource = readFileSync('static/app/utils.js', 'utf8');
        const modalSource = readFileSync('static/app/modal.js', 'utf8');

        expect(utilsSource).toContain("id: 'PROXY_ID'");
        expect(utilsSource).toContain("type: 'proxy-select'");
        expect(modalSource).toContain('loadProxyPools');
        expect(modalSource).toContain('renderProxySelectOptions');
        expect(modalSource).toContain('/proxy-pools');
    });

    test('provider manager exposes a proxy pool management entry', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(modalSource).toContain('showProxyPoolManager');
        expect(modalSource).toContain('saveProxyPools');
        expect(i18nSource).toContain('modal.proxyPool.title');
    });

    test('proxy pool manager stores expected exit IP for preflight checks', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');

        expect(modalSource).toContain('expectedIp');
        expect(modalSource).toContain('data-proxy-field="expectedIp"');
    });
});
