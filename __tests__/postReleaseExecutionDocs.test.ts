import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const issueUrl = (issue: number): string =>
  `https://github.com/OpenCoven/psyche-build/issues/${issue}`;

const pullUrl = (pull: number): string =>
  `https://github.com/OpenCoven/psyche-build/pull/${pull}`;

const controlDocuments = async (): Promise<Array<{ filePath: string; source: string }>> =>
  Promise.all(
    ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
      filePath,
      source: await readFile(filePath, 'utf8'),
    })),
  );

const expectAnyPhrase = (
  source: string,
  phrases: readonly string[],
  context: string,
): void => {
  const normalized = source.toLowerCase();
  expect(
    phrases.some((phrase) => normalized.includes(phrase.toLowerCase())),
    `${context}: expected one of ${phrases.join(', ')}`,
  ).toBe(true);
};

const expectPrDisposition = (
  source: string,
  filePath: string,
  pull: number,
  disposition: RegExp,
): void => {
  expect(source, `${filePath} missing pull request #${pull}`).toContain(pullUrl(pull));
  expect(source, `${filePath} missing disposition for PR #${pull}`).toMatch(
    new RegExp(`#${pull}\\b[\\s\\S]{0,420}${disposition.source}`, 'i'),
  );
};

const expectOrderedUrls = (
  source: string,
  firstUrl: string,
  secondUrl: string,
  context: string,
): void => {
  const firstIndex = source.indexOf(firstUrl);
  const secondIndex = source.indexOf(secondUrl);
  expect(firstIndex, `${context}: missing ${firstUrl}`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${context}: missing ${secondUrl}`).toBeGreaterThanOrEqual(0);
  expect(firstIndex, `${context}: expected ${firstUrl} before ${secondUrl}`).toBeLessThan(secondIndex);
};

describe('post-release execution documentation', () => {
  it('records completed control foundations without falsely closing live governance', async () => {
    const documents = await controlDocuments();

    for (const { filePath, source } of documents) {
      expect(source, filePath).toMatch(/## Delivered(?: control)? foundation/i);
      expect(source, filePath).toContain(pullUrl(245));
      expect(source, filePath).toContain('5f4b7b05');
      for (const issue of [237, 238, 240, 244]) {
        expect(source, `${filePath} missing completed outcome #${issue}`).toContain(issueUrl(issue));
      }
      expect(source, filePath).toContain(pullUrl(272));
      expect(source, filePath).toContain(pullUrl(273));
      expect(source, filePath).toContain(issueUrl(31));
      expect(source, filePath).toMatch(
        /#31[\s\S]{0,420}(?:not delivered|not part of the\s+completed list|open governance)/i,
      );
      expect(source, filePath).toMatch(/enforcement_level:\s*non_admins/i);
      expect(source, filePath).toMatch(/administrator enforcement/i);
      expect(source, filePath).toMatch(/direct-push rejection/i);
      expect(source, filePath).toMatch(/standing (?:broad )?bypass/i);
      expect(source, filePath).not.toMatch(/#31[\s\S]{0,180}delivered by this wave/i);
      expect(source, filePath).not.toMatch(/when this proof PR merges/i);
    }
  });

  it('distinguishes the supported v0.0.1 release from the unreleased 0.0.2 candidate', async () => {
    const [roadmap, execution, support, packageSource] = await Promise.all([
      readFile('docs/ROADMAP.md', 'utf8'),
      readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8'),
      readFile('docs/SUPPORT-MATRIX.md', 'utf8'),
      readFile('package.json', 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource) as { version: string };

    expect(packageJson.version).toBe('0.0.2');
    for (const [name, source] of [
      ['roadmap', roadmap],
      ['execution', execution],
      ['support', support],
    ] as const) {
      expect(source, name).toContain('57c6c71bd5264fde960b062e95de278c8438c94f');
      expect(source, name).toContain('v0.0.1');
      expect(source, name).toContain('0.0.2');
      expect(source, name).toMatch(/unreleased candidate/i);
    }

    expect(roadmap).toMatch(/not a\s+publication event/i);
    expect(execution).toMatch(/Do not infer release/i);
    expect(support).toMatch(/latest supported public release is[\s\S]{0,100}v0\.0\.1/i);
    expect(support).toMatch(/0\.0\.2[\s\S]{0,180}not a supported distribution/i);
    expect(support).toMatch(/iOS application[\s\S]{0,180}Planned internal beta pending #200/i);
    expect(support).toMatch(/Only an immutable TestFlight build[\s\S]{0,180}Internal beta/i);
  });

  it('names the complete current portfolio and preserves the ordered gates', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');

    for (const issue of [31, 195, 196, 197, 198, 199, 200, 201, 237, 238, 239, 240, 241, 242, 243, 244, 246, 253, 279, 280]) {
      expect(execution, `missing issue #${issue}`).toContain(issueUrl(issue));
    }

    expect(execution).toMatch(/#196\/#239 are the current P0 stabilization critical\s+path/i);
    expect(execution).toMatch(/#31[\s\S]{0,220}parallel P0 governance gate/i);
    expectOrderedUrls(execution, issueUrl(241), issueUrl(280), 'iOS readiness before invite authentication');
    expectOrderedUrls(execution, issueUrl(280), issueUrl(242), 'invite authentication before production actions');
    expect(execution).toMatch(/#242 publication precedes execution/i);
    expect(execution).toMatch(/execution precedes mobile controls/i);
    expect(execution).toMatch(/#279[\s\S]{0,280}cannot[\s\S]{0,160}block #196, #199, or #200/i);
  });

  it('records current pull-request disposition instead of equating green CI with readiness', async () => {
    const documents = await controlDocuments();

    for (const { filePath, source } of documents) {
      expectPrDisposition(source, filePath, 274, /\*\*Merged\*\*[\s\S]{0,140}f12b7534/i);
      expectPrDisposition(source, filePath, 281, /\*\*Changes requested\*\*/i);
      expectPrDisposition(source, filePath, 278, /\*\*Changes requested\*\*/i);
      expectPrDisposition(source, filePath, 277, /\*\*Design correction required; not merge-ready\*\*/i);
      expectPrDisposition(source, filePath, 264, /\*\*Draft source material only\*\*/i);
      expectPrDisposition(source, filePath, 262, /\*\*Merged focused mapping slice\*\*/i);
      expectPrDisposition(source, filePath, 236, /\*\*Closed as superseded\*\*/i);
      for (const pull of [190, 192, 193, 254]) {
        expectPrDisposition(source, filePath, pull, /\*\*Source material only\*\*/i);
      }
      expect(source, filePath).toMatch(/No listed open implementation PR is\s+merge-ready/i);
      expect(source, filePath).toMatch(/unresolved requested changes|not merge-ready|design correction required/i);
    }
  });

  it('protects the active privacy, diagnostics, iOS, and runtime-adapter findings', async () => {
    const [roadmap, execution, support] = await Promise.all([
      readFile('docs/ROADMAP.md', 'utf8'),
      readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8'),
      readFile('docs/SUPPORT-MATRIX.md', 'utf8'),
    ]);

    for (const [name, source] of [
      ['roadmap', roadmap],
      ['execution', execution],
      ['support', support],
    ] as const) {
      expect(source, name).toContain(issueUrl(243));
      expect(source, name).toContain(pullUrl(278));
      expectAnyPhrase(source, ['terminal free text', 'terminal content', 'terminal output'], `${name} terminal privacy`);
      expectAnyPhrase(source, ['omit', 'fail closed', 'proven-safe'], `${name} terminal admission`);
      expect(source.toLowerCase(), `${name} collector contract`).toContain('collector');
      expectAnyPhrase(source, ['collector conflict', 'collector ownership', 'duplicate collector'], `${name} collector truth`);
      expectAnyPhrase(source, ['action vocabulary', 'action states', 'state vocabulary'], `${name} action state contract`);
      expect(source.toLowerCase(), `${name} authoritative receipts`).toContain('receipt');
      expectAnyPhrase(source, ['traversal', 'normalization'], `${name} bounded traversal`);
      expectAnyPhrase(source, ['bound', 'elapsed'], `${name} elapsed/bound contract`);

      expect(source, name).toContain(issueUrl(279));
      expect(source.toLowerCase(), `${name} Coven adapter`).toContain('coven');
      expect(source.toLowerCase(), `${name} prompt transport`).toContain('prompt');
      expectAnyPhrase(source, ['process argv', 'process arguments'], `${name} process-argument privacy`);
      expect(source.toLowerCase(), `${name} launch metadata`).toContain('launch metadata');
      expect(source.toLowerCase(), `${name} capability negotiation`).toContain('capability');
      expect(source.toLowerCase(), `${name} profile negotiation`).toContain('profile');

      expect(source, name).toContain(issueUrl(280));
      expectOrderedUrls(source, issueUrl(241), issueUrl(280), `${name} #241 before #280`);
      expect(source, name).toMatch(/PR #264[\s\S]{0,260}(?:source material|not a\s+merge-ready)/i);
    }

    for (const { filePath, source } of await controlDocuments()) {
      expect(source, filePath).toContain(pullUrl(281));
      expect(source, filePath).toContain(issueUrl(199));
      expectAnyPhrase(source, ['compile-time debug boundary', 'debug-build boundary'], `${filePath} debug boundary`);
      expect(source.toLowerCase(), `${filePath} invoking webview`).toContain('invoking webview');
      expect(source.toLowerCase(), `${filePath} launcher spawn error`).toContain('spawn error');
      expect(source, filePath).toMatch(/generated (?:Beads task|#230|issue body)[\s\S]{0,240}(?:one-way mirror|not manually)/i);
    }
  });

  it('retains every dependency gate and keeps P2 work non-blocking', async () => {
    const documents = await controlDocuments();

    for (const { filePath, source } of documents) {
      expect(source, filePath).toMatch(/#200\/#241 retains its P1 dependency gate/i);
      expect(source, filePath).toMatch(/#199\/#243 retains its P1 dependency gate/i);
      expect(source, filePath).toMatch(/#198\/#244 retains its P1 dependency gate/i);
      expect(source, filePath).toMatch(/#197 retains its P1 dependency gate/i);
      expect(source, filePath).toMatch(/#201\/#253 retains its P2 dependency gate/i);
      expect(source, filePath).toMatch(/#246 retains its P2 dependency gate/i);
      expect(source, filePath).toContain(pullUrl(262));
      expect(source, filePath).toMatch(/PR #262 is the focused replacement for #254(?:'s)? mapping scope/i);
      expect(source, filePath).toMatch(/#201\/#253\/#279[\s\S]{0,240}(?:cannot block|implementation cannot block)[\s\S]{0,140}#196[\s\S]{0,100}#199[\s\S]{0,100}#200/i);
    }
  });

  it('documents canonical Beads mapping and review before Dolt publication', async () => {
    const [beads, roadmap, execution] = await Promise.all([
      readFile('.beads/README.md', 'utf8'),
      readFile('docs/ROADMAP.md', 'utf8'),
      readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8'),
    ]);

    expect(beads).toMatch(/`external_ref`[\s\S]{0,160}canonical public outcome\/maintenance-bucket field/i);
    expect(beads).toMatch(/active Bead[\s\S]{0,160}exactly one valid configured target/i);
    expect(beads).toMatch(/priority[\s\S]{0,100}match(?:es|ing)?\s+(?:the\s+)?roadmap\s+priority/i);
    expect(beads).toMatch(/generated GitHub bodies[\s\S]{0,160}one-way mirrors/i);
    expect(beads).toMatch(/never\s+the\s+source\s+of\s+repair/i);
    expect(beads).toMatch(/review before `bd dolt push`/i);
    expect(beads).toMatch(/sandbox[\s\S]{0,80}no auto-push/i);
    expect(beads).toMatch(/merge the Git PR[\s\S]{0,120}tracked audit\/config\/code/i);
    expect(beads).toMatch(/publish the exact reviewed Dolt commit/i);
    expect(beads).toMatch(/run the protected sync/i);

    for (const source of [roadmap, execution]) {
      expect(source).toMatch(/Generated GitHub[\s\S]{0,180}one-way mirrors/i);
      expect(source).toMatch(/Never (?:edit|repair)[\s\S]{0,180}generated/i);
      expect(source).toMatch(/review[\s\S]{0,100}Dolt diff/i);
      expect(source).toMatch(/protected synchronizer/i);
    }
  });

  it('keeps roadmap, execution, support, docs index, and acceptance connected', async () => {
    const [roadmap, execution, support, index, acceptance] = await Promise.all([
      readFile('docs/ROADMAP.md', 'utf8'),
      readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8'),
      readFile('docs/SUPPORT-MATRIX.md', 'utf8'),
      readFile('docs/README.md', 'utf8'),
      readFile('docs/RELEASE-ACCEPTANCE.md', 'utf8'),
    ]);

    for (const contents of [roadmap, support, index, acceptance]) {
      expect(contents).toContain('POST-RELEASE-EXECUTION.md');
    }
    expect(execution).toContain('ROADMAP.md');
    expect(execution).toContain('SUPPORT-MATRIX.md');
    expect(roadmap).toContain(issueUrl(237));
    expect(roadmap).toContain(issueUrl(240));
    expect(acceptance).toContain(issueUrl(239));
    expect(acceptance).toContain('**Complete**');
    expect(acceptance).toContain('**Open post-release stabilization debt**');
    expect(acceptance).toMatch(/completed publication evidence[\s\S]{0,180}operator-observed acceptance work/i);
  });

  it('states merge and closure gates in evidence terms rather than test-count terms', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');

    expect(execution).toContain('exact final head');
    expect(execution).toMatch(/required checks are terminal and successful on the exact final head/i);
    expect(execution).toMatch(/no unresolved current review finding/i);
    expect(execution).toMatch(/Documentation and test counts[\s\S]{0,140}not substitutes/i);
    expect(execution).toMatch(/Closing a public outcome requires[\s\S]{0,140}every child gate/i);
  });
});