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

describe('post-release execution documentation', () => {
  it('records completed control foundations without falsely closing live governance', async () => {
    const documents = await controlDocuments();

    for (const { filePath, source } of documents) {
      expect(source, filePath).toContain(pullUrl(245));
      expect(source, filePath).toContain('5f4b7b05');
      expect(source, filePath).toMatch(/#238[\s\S]{0,240}(?:delivered|completed)/i);
      expect(source, filePath).toMatch(/#237[\s\S]{0,240}(?:completed|delivered|first apply)/i);
      expect(source, filePath).toMatch(/#240[\s\S]{0,240}(?:completed|delivered|zero-operation)/i);
      expect(source, filePath).toMatch(/#244[\s\S]{0,240}(?:completed|delivered|community)/i);
      expect(source, filePath).toContain(pullUrl(272));
      expect(source, filePath).toContain(pullUrl(273));
      expect(source, filePath).toContain(issueUrl(31));
      expect(source, filePath).toMatch(/#31[\s\S]{0,220}(?:not delivered|open governance|parallel P0 governance)/i);
      expect(source, filePath).toMatch(/enforcement_level:\s*non_admins/i);
      expect(source, filePath).toMatch(/administrator enforcement/i);
      expect(source, filePath).toMatch(/direct-push rejection/i);
      expect(source, filePath).toMatch(/standing (?:broad )?bypass/i);
      expect(source, filePath).not.toMatch(/#31[\s\S]{0,160}delivered by this wave/i);
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
    for (const source of [roadmap, execution, support]) {
      expect(source).toContain('57c6c71bd5264fde960b062e95de278c8438c94f');
      expect(source).toMatch(/v0\.0\.1[\s\S]{0,180}(?:released|supported)/i);
      expect(source).toMatch(/0\.0\.2[\s\S]{0,180}unreleased candidate/i);
      expect(source).toMatch(/latest (?:supported )?public release[\s\S]{0,120}v0\.0\.1/i);
      expect(source).toMatch(/(?:version string|package\.json|changelog|merge)[\s\S]{0,220}(?:not|is not)[\s\S]{0,80}(?:publication|release)/i);
    }
    expect(support).toMatch(/iOS application[\s\S]{0,160}Planned internal beta pending #200/i);
    expect(support).toMatch(/Only an immutable TestFlight build[\s\S]{0,160}Internal beta/i);
  });

  it('names the complete current portfolio and its ordered gates', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');

    for (const issue of [31, 195, 196, 197, 198, 199, 200, 201, 237, 238, 239, 240, 241, 242, 243, 244, 246, 253, 279, 280]) {
      expect(execution, `missing issue #${issue}`).toContain(issueUrl(issue));
    }

    expect(execution).toMatch(/#196\/#239 are the current P0 stabilization critical\s+path/i);
    expect(execution).toMatch(/#31[\s\S]{0,180}parallel P0 governance gate/i);
    expect(execution).toMatch(/#241 atomic readiness[\s\S]{0,240}#280 focused invite-auth/i);
    expect(execution).toMatch(/#280[\s\S]{0,240}physical same-LAN proof[\s\S]{0,240}#242/i);
    expect(execution).toMatch(/#242 publication precedes execution/i);
    expect(execution).toMatch(/execution precedes mobile controls/i);
    expect(execution).toMatch(/#279[\s\S]{0,220}cannot[\s\S]{0,120}block #196, #199, or #200/i);
  });

  it('records current pull-request disposition instead of equating green CI with readiness', async () => {
    const documents = await controlDocuments();

    for (const { filePath, source } of documents) {
      for (const pull of [190, 192, 193, 236, 254, 262, 264, 274, 277, 278]) {
        expect(source, `${filePath} missing pull request #${pull}`).toContain(pullUrl(pull));
      }
      expect(source, filePath).toMatch(/#274[\s\S]{0,180}\*\*Merged\*\*[\s\S]{0,100}f12b7534/i);
      expect(source, filePath).toMatch(/#278[\s\S]{0,180}\*\*Changes requested\*\*/i);
      expect(source, filePath).toMatch(/#277[\s\S]{0,220}\*\*Design correction required; not merge-ready\*\*/i);
      expect(source, filePath).toMatch(/#264[\s\S]{0,220}\*\*Draft source material only\*\*/i);
      expect(source, filePath).toMatch(/#262[\s\S]{0,180}\*\*Merged focused mapping slice\*\*/i);
      expect(source, filePath).toMatch(/#236[\s\S]{0,180}\*\*Closed as superseded\*\*/i);
      for (const pull of [190, 192, 193, 254]) {
        expect(source, `${filePath} changed PR #${pull} source disposition`).toMatch(
          new RegExp(`${pullUrl(pull).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,220}\\*\\*Source material only\\*\\*`, 'i'),
        );
      }
      expect(source, filePath).toMatch(/No listed open implementation PR is\s+merge-ready/i);
      expect(source, filePath).toMatch(/green CI[\s\S]{0,180}(?:not|does not)[\s\S]{0,120}(?:readiness|resolve|establish)/i);
    }
  });

  it('protects the active privacy, iOS, and runtime-adapter review findings', async () => {
    const [roadmap, execution, support] = await Promise.all([
      readFile('docs/ROADMAP.md', 'utf8'),
      readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8'),
      readFile('docs/SUPPORT-MATRIX.md', 'utf8'),
    ]);

    for (const source of [roadmap, execution, support]) {
      expect(source).toContain(issueUrl(243));
      expect(source).toContain(pullUrl(278));
      expect(source).toMatch(/terminal[\s\S]{0,180}(?:free text|content|output)[\s\S]{0,220}(?:omit|fail closed|proven-safe)/i);
      expect(source).toMatch(/collector[\s\S]{0,180}(?:conflict|ownership)[\s\S]{0,180}(?:truth|silently|complete)/i);
      expect(source).toMatch(/action vocabulary[\s\S]{0,180}(?:receipt|authoritative)/i);
      expect(source).toMatch(/(?:traversal|normalization)[\s\S]{0,180}(?:bound|elapsed)/i);

      expect(source).toContain(issueUrl(279));
      expect(source).toMatch(/prompt[\s\S]{0,160}(?:process argv|process arguments)[\s\S]{0,200}(?:persistent|launch metadata)/i);
      expect(source).toMatch(/Coven[\s\S]{0,180}(?:version\/profile|profile\/capability|capability\/version)/i);

      expect(source).toContain(issueUrl(280));
      expect(source).toMatch(/#241[\s\S]{0,220}(?:precedes|after)[\s\S]{0,180}#280/i);
      expect(source).toMatch(/PR #264[\s\S]{0,220}(?:source material|not a\s+merge-ready)/i);
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
      expect(source, filePath).toMatch(/#201\/#253\/#279[\s\S]{0,180}(?:cannot block|implementation cannot block)[\s\S]{0,100}#196[\s\S]{0,80}#199[\s\S]{0,80}#200/i);
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
    expect(execution).toMatch(/Documentation and test counts[\s\S]{0,100}not substitutes/i);
    expect(execution).toMatch(/Closing a public outcome requires[\s\S]{0,100}every child gate/i);
  });
});