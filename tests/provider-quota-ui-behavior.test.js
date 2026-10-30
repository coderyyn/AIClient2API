import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

function loadFunction(path, name, bindings = {}) {
    const source = readFileSync(path, 'utf8');
    const node = parse(source, { sourceType: 'module' }).program.body.find(n => n.type === 'FunctionDeclaration' && n.id?.name === name);
    if (!node) throw new Error(`Function missing: ${name}`);
    return new Function(...Object.keys(bindings), `${source.slice(node.start, node.end)}; return ${name};`)(...Object.values(bindings));
}

const escapeHtml = loadFunction('static/app/utils.js', 'escapeHtml');
const render = loadFunction('static/app/modal.js', 'renderProviderQuotaChips', {
    escapeHtml, t: (_key, { day }) => `reset ${day}`
});
const collect = loadFunction('static/app/modal.js', 'collectDraftProviderConfig', {
    CODEX_QUOTA_PERCENT_FIELDS: new Set(), usesManagedModelList: () => false
});

test('HTML escaping protects both text and quoted attributes', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    const html = render({ accountEmail: '" onmouseover="alert(1)', quotaResetDay: 14 });
    expect(html).not.toContain('title="" onmouseover="');
    expect(html).toContain('title="&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('reset 14');
});

test.each(['', '0', '32'])('invalid reset day %s is not rendered or persisted as a valid day', day => {
    expect(render({ quotaResetDay: day })).toBe('');
    const detail = { querySelectorAll: selector => selector === 'input[data-config-key]'
        ? [{ dataset: { configKey: 'quotaResetDay' }, value: day }]
        : [] };
    expect(collect(detail, 'openaiResponses-custom', 'synthetic').quotaResetDay).toBeNull();
});

test('email trimming and numeric reset day survive collection for saving', () => {
    const detail = { querySelectorAll: selector => selector === 'input[data-config-key]' ? [
        { dataset: { configKey: 'accountEmail' }, value: ' user@example.invalid ' },
        { dataset: { configKey: 'quotaResetDay' }, value: '31' }
    ] : [] };
    expect(collect(detail, 'openaiResponses-custom', 'synthetic')).toEqual({
        accountEmail: 'user@example.invalid', quotaResetDay: 31, notSupportedModels: []
    });
});
