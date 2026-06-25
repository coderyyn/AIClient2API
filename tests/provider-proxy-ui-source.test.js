import { readFileSync } from 'fs';

describe('provider proxy UI source', () => {
    test('Codex provider edit fields expose provider-level proxy settings', () => {
        const source = readFileSync('static/app/utils.js', 'utf8');

        const codexSection = source.slice(
            source.indexOf("'openai-codex-oauth': ["),
            source.indexOf("'grok-cli-oauth': [")
        );

        expect(codexSection).toContain("id: 'PROXY_URL'");
        expect(codexSection).toContain("id: 'PROXY_REQUIRED'");
        expect(codexSection).toContain("id: 'PROXY_ID'");
        expect(codexSection).toContain("type: 'boolean'");
        expect(source).toContain("'PROXY_URL':");
        expect(source).toContain("'PROXY_REQUIRED':");
        expect(source).toContain("'PROXY_ID':");
    });

    test('provider edit modal renders boolean provider fields as selects', () => {
        const source = readFileSync('static/app/modal.js', 'utf8');

        expect(source).toContain("fieldDef.type === 'boolean'");
        expect(source).toContain("field1.type === 'boolean'");
        expect(source).toContain("field.id === 'PROXY_REQUIRED'");
        expect(source).toContain('<select class="form-control"');
    });
});
