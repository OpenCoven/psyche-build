import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const issueUrl = (issue: number): string =>
  `https://github.com/OpenCoven/psyche-build/issues/${issue}`;

const pullUrl = (pull: number): string =>
  `https://github.com/OpenCoven/psyche-build/pull/${pull}`;

describe('post-release execution documentation', () => {
  it('records the Stage 0 proof wave as closed with linked evidence before the active P0 gate', async () => {
    const documents = await Promise.all(
      ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of documents) {
      expect(source, filePath).toContain(pullUrl(245));
      expect(source, filePath).toContain('5f4b7b05');
      expect(source, filePath).toMatch(/#238[\s\S]{0,240}(?:delivered|completed)/i);
      expect(source, filePath).toMatch(/#240[\s\S]{0,120}closed on[\s\S]{0,40}2026-08-28/i);
      expect(source, filePath).toMatch(/#237[\s\S]{0,120}closed on[\s\S]{0,40}2026-08-29/i);
      expect(source, filePath).toMatch(/#31[\s\S]{0,120}closed on[\s\S]{0,40}2026-08-30/i);
      expect(source, filePath).toContain(pullUrl(263));
      expect(source, filePath).toContain(pullUrl(283));
      expect(source, filePath).toContain(pullUrl(330));
      expect(source, filePath).toContain('63667f30');
      expect(source, filePath).toMatch(/GH013/);
      expect(source, filePath).toContain('#196/#239 remain the active P0 critical path');
      expect(source, filePath).toMatch(/policy evidence/i);
      expect(source, filePath).not.toMatch(/when this proof PR merges/i);
      expect(source, filePath).not.toMatch(/delivered by this wave/i);
      const stale238Claims = source
        .split(/\n\s*\n/)
        .filter((paragraph) => /#238/.test(paragraph))
        .filter((paragraph) =>
          /(?:current critical-path|remains pending|is pending|pending work|merge this current-main|merge the #238)/i.test(
            paragraph,
          ),
        );
      expect(stale238Claims, filePath).toEqual([]);
      expect(source, filePath).not.toMatch(
        /(?:#31|#237|#240)[^\n]{0,220}(?:current blocker|precedes stabilization|open governance debt)/i,
      );
      expect(source, filePath).not.toMatch(/while Stage 0 proceeds/i);
    }
  });

  it('records the slices merged since 2026-08-28 against their owning outcomes without support claims', async () => {
    const documents = await Promise.all(
      ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of documents) {
      for (const issue of [243, 244, 198, 279, 280]) {
        expect(source, `${filePath} missing issue #${issue}`).toContain(issueUrl(issue));
      }
      for (const pull of [261, 278, 321, 322, 323]) {
        expect(source, `${filePath} missing pull request #${pull}`).toContain(pullUrl(pull));
      }
      expect(source, filePath).toMatch(
        /#243[\s\S]{0,200}(?:delivered|closed)[\s\S]{0,200}(?:without production collector wiring|no production collector wiring|schema only|schema, bounds)/i,
      );
      expect(source, filePath).toMatch(/#198\/#244[\s\S]{0,120}delivered/i);
      expect(source, filePath).toMatch(/PR #322[\s\S]{0,240}(?:publication only|execution and (?:mobile )?controls)/i);
      expect(source, filePath).toMatch(/PR #323[\s\S]{0,240}(?:no pairing|physical acceptance)/i);
      expect(source, filePath).toMatch(/0\.0\.2[\s\S]{0,120}unreleased candidate/i);
      expect(source, filePath).toMatch(/scheduled Beads Project sync[\s\S]{0,160}failed/i);
      expect(source, filePath).toMatch(/psyche-z7c\.4\.4[\s\S]{0,80}#230/);
      expect(source, filePath).not.toMatch(/(?:iOS|TestFlight)[^\n]{0,120}(?:now supported|internal beta is (?:live|available))/i);
    }
  });

  it('records administrator enforcement with one named PR-only owner bypass for Stage 0', async () => {
    const documents = await Promise.all(
      ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of documents) {
      expect(source, filePath).toMatch(/administrator enforcement/i);
      expect(source, filePath).toMatch(/single named PR-only owner bypass[\s\S]{0,100}BunsDev/i);
      expect(source, filePath).toMatch(/all other actors[\s\S]{0,160}(?:require|remain subject to)[\s\S]{0,80}approval/i);
      expect(source, filePath).toMatch(/direct-push rejection proof/i);
      expect(source, filePath).toMatch(/direct pushes[\s\S]{0,120}platform-blocked[\s\S]{0,100}BunsDev/i);
      expect(source, filePath).toMatch(/GitHub[\s\S]{0,100}(?:cannot|does not)[\s\S]{0,100}self-approval/i);
      expect(source, filePath).toMatch(
        /BunsDev[\s\S]{0,180}explicit PR-only bypass[\s\S]{0,160}admin merge[\s\S]{0,180}exact-head[\s\S]{0,120}resolved conversations/i,
      );
      expect(source, filePath).not.toMatch(/classic `?bypass_pull_request_allowances`?[\s\S]{0,100}(?:BunsDev|owner)/i);
      expect(source, filePath).not.toMatch(/no standing (?:bypass )?actor/i);
      expect(source, filePath).not.toMatch(/zero (?:standing )?bypasses/i);
    }
  });

  it('names the complete critical path without changing support claims', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');

    for (const issue of [31, 195, 196, 197, 198, 199, 200, 201, 237, 238, 239, 240, 241, 242, 243, 244, 246, 253]) {
      expect(execution, `missing issue #${issue}`).toContain(issueUrl(issue));
    }

    expect(execution).toContain('57c6c71bd5264fde960b062e95de278c8438c94f');
    expect(execution).toMatch(/v0\.0\.1[\s\S]{0,100}(?:released and supported|supported)/i);
    expect(execution).toMatch(/iOS companion remains[\s\S]{0,100}planned/i);
    expect(execution).toMatch(/do not establish live TestFlight availability/i);
    expect(execution).toMatch(/#241 atomic readiness[\s\S]{0,200}#242 publication/i);
    expect(execution).toMatch(/#242 publication precedes execution/i);
    expect(execution).toMatch(/execution precedes mobile controls/i);
    expect(execution).toContain(pullUrl(248));
    expect(execution).toContain(pullUrl(249));
    expect(execution).toContain(pullUrl(247));
    expect(execution).toMatch(/zero mutations[\s\S]{0,80}two GraphQL queries/i);
  });

  it('records stale pull requests as source or history rather than merge-ready work', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');
    const roadmap = await readFile('docs/ROADMAP.md', 'utf8');

    for (const pull of [190, 192, 193, 236]) {
      expect(execution, `missing pull request #${pull}`).toContain(pullUrl(pull));
      expect(roadmap, `roadmap missing pull request #${pull}`).toContain(pullUrl(pull));
    }

    expect(execution).toMatch(/#236[\s\S]{0,160}\*\*Closed as superseded\*\*/i);
    expect(roadmap).toMatch(/#236[\s\S]{0,160}\*\*Closed as superseded\*\*/i);
    expect(execution).toMatch(/listed source-material PRs are not merge-ready/i);
    expect(roadmap).toMatch(/source-material PRs above are not merge-ready/i);
  });

  it('retains dependency gates and keeps unrelated PR #254 outside Stage 0', async () => {
    const documents = await Promise.all(
      ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of documents) {
      for (const issue of [197, 198, 199, 200, 201, 241, 243, 244, 246, 253]) {
        expect(source, `${filePath} missing issue #${issue}`).toContain(issueUrl(issue));
      }
      for (const pull of [190, 192, 193]) {
        expect(source, `${filePath} changed PR #${pull} disposition`).toMatch(
          new RegExp(`${pullUrl(pull).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,220}\\*\\*Source material only\\*\\*`, 'i'),
        );
      }
      expect(source, filePath).toMatch(/#200\/#241[\s\S]{0,160}P1 dependency gate/i);
      expect(source, filePath).toMatch(/#199\/#243[\s\S]{0,160}P1 dependency gate/i);
      expect(source, filePath).toMatch(/#198\/#244[\s\S]{0,160}(?:delivered|no longer sequences)/i);
      expect(source, filePath).toMatch(/#197[\s\S]{0,160}P1 dependency gate/i);
      expect(source, filePath).toMatch(/#201\/#253[\s\S]{0,160}P2 dependency gate/i);
      expect(source, filePath).toMatch(/#246[\s\S]{0,160}P2 dependency gate/i);
      expect(source, filePath).toContain(pullUrl(262));
      expect(source, filePath).toMatch(
        /PR #262 is the\s+focused replacement for #254(?:'s)? mapping\s+scope/i,
      );
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
    expect(beads).toMatch(/generated interactions[\s\S]{0,100}local Dolt diff/i);
    expect(beads).toMatch(/merge the Git PR[\s\S]{0,120}tracked audit\/config\/code/i);
    expect(beads).toMatch(/publish the exact reviewed Dolt commit/i);
    expect(beads).toMatch(/run the protected sync/i);
    expect(beads).not.toMatch(
      /(?:edit|change|repair) generated GitHub bodies directly/i,
    );

    const permissiveMirrorParagraphs = [beads, roadmap, execution]
      .flatMap((source) => source.split(/\n\s*\n/))
      .filter((paragraph) => /(?:generated GitHub|generated mirror|mirrored issue)/i.test(paragraph))
      .filter((paragraph) => /(?:edit|change|repair|authoritative source)/i.test(paragraph))
      .filter((paragraph) => !/(?:do not|never|must not|cannot|not the source)/i.test(paragraph));
    expect(permissiveMirrorParagraphs).toEqual([]);
  });

  it('keeps the roadmap, docs index, and acceptance contract connected', async () => {
    const [roadmap, index, acceptance] = await Promise.all([
      readFile('docs/ROADMAP.md', 'utf8'),
      readFile('docs/README.md', 'utf8'),
      readFile('docs/RELEASE-ACCEPTANCE.md', 'utf8'),
    ]);

    for (const contents of [roadmap, index, acceptance]) {
      expect(contents).toContain('POST-RELEASE-EXECUTION.md');
    }

    expect(roadmap).toContain(issueUrl(237));
    expect(roadmap).toContain(issueUrl(240));
    expect(acceptance).toContain(issueUrl(239));
    expect(acceptance).toContain('**Complete**');
    expect(acceptance).toContain('**Open post-release stabilization debt**');
    expect(acceptance).not.toContain('**Open governance debt**');
    expect(acceptance).toMatch(/#31 closed on 2026-08-30/i);
    expect(acceptance).toContain(issueUrl(31));
    expect(acceptance).toMatch(/\| \*\*Complete\*\* \| \[#31\]/);
    expect(acceptance).toMatch(/completed publication evidence[\s\S]{0,180}operator-observed acceptance work/i);
  });

  it('states merge and closure gates in evidence terms rather than test-count terms', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');

    expect(execution).toContain('exact final head');
    expect(execution).toMatch(/required checks are terminal and successful on the exact head/i);
    expect(execution).toMatch(/no unresolved current review finding/i);
    expect(execution).toMatch(/Documentation and test counts[\s\S]{0,100}not substitutes/i);
    expect(execution).toMatch(/Closing a public outcome requires every child gate/i);
  });
});
