import fs from 'fs';
import path from 'path';

describe('Codex usage source regressions', () => {
    test('Codex usage limits also fetch the CLI token usage profile endpoint', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/providers/openai/codex-core.js'), 'utf8');

        expect(source).toContain('https://chatgpt.com/backend-api/wham/usage');
        expect(source).toContain('https://chatgpt.com/backend-api/wham/profiles/me');
        expect(source).toContain('token_usage_profile');
    });
});
