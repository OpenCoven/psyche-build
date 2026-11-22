import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AGENTS_MD } from '../src/utils/generated-agents-doc.js';

/**
 * `scripts/generate-hooks-docs.js` writes the hooks guide into a TypeScript
 * template literal. A template literal gives `\`, a backtick and `${` special
 * meaning, so every one of them has to be escaped or the published guide
 * silently differs from the Markdown the generator built.
 */
describe('generated hooks guide', () => {
  it('keeps the backslash line continuations in multi-line shell examples', () => {
    expect(AGENTS_MD).toContain(
      'curl -X PUT "http://localhost:$PSYCHE_SERVER_PORT/api/panes/$PSYCHE_PANE_ID/test" \\\n'
      + '  -H "Content-Type: application/json" \\\n',
    );
  });

  it('keeps regular-expression escapes in shell examples', () => {
    expect(AGENTS_MD).toContain("grep -oP 'localhost:\\K\\d+'");
    expect(AGENTS_MD).toContain("grep -oP 'https://[a-z0-9-]+\\.trycloudflare\\.com'");
  });

  it('keeps escaped quotes inside double-quoted shell strings', () => {
    expect(AGENTS_MD).toContain('-d "{\\"status\\": \\"running\\", \\"url\\": \\"$URL\\"}"');
  });

  it('publishes shell parameter expansions without a stray backslash', () => {
    expect(AGENTS_MD).toContain('URL="${TUNNEL:-http://localhost:$PORT}"');
    expect(AGENTS_MD).not.toContain('\\${');
  });

  it('escapes backslashes, backticks and interpolation markers in the generator', () => {
    const generator = readFileSync(
      path.join(__dirname, '..', 'scripts', 'generate-hooks-docs.js'),
      'utf-8',
    );
    expect(generator).toContain(".replace(/\\\\/g, '\\\\\\\\')");
    expect(generator).toContain(".replace(/`/g, '\\\\`')");
    expect(generator).toContain(".replace(/\\$\\{/g, '\\\\${')");
  });
});
