import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const issueUrl = (issue: number): string =>
  `https://github.com/OpenCoven/psyche-build/issues/${issue}`;

const pullUrl = (pull: number): string =>
  `https://github.com/OpenCoven/psyche-build/pull/${pull}`;

const runUrl = (run: number): string =>
  `https://github.com/OpenCoven/psyche-build/actions/runs/${run}`;

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
      for (const issue of [198, 242, 243, 244, 252, 279, 280]) {
        expect(source, `${filePath} missing issue #${issue}`).toContain(issueUrl(issue));
      }
      for (const pull of [260, 261, 278, 321, 322, 323]) {
        expect(source, `${filePath} missing pull request #${pull}`).toContain(pullUrl(pull));
      }
      expect(source, filePath).toMatch(
        /#243[\s\S]{0,200}(?:delivered|closed)[\s\S]{0,200}(?:without production collector wiring|no production collector wiring|schema only|schema, bounds)/i,
      );
      expect(source, filePath).toMatch(/#198\/#244[\s\S]{0,120}delivered/i);
      expect(source, filePath).toMatch(/PR #322[\s\S]{0,240}(?:publication only|execution and (?:mobile )?controls)/i);
      expect(source, filePath).toMatch(/PR #323[\s\S]{0,240}(?:no pairing|physical acceptance)/i);
      expect(source, filePath).toContain('https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.2');
      expect(source, filePath).toContain('a4546f45bb0ee05cfbb388a0fc5f9e951596be51');
      expect(source, filePath).not.toMatch(/0\.0\.2[\s\S]{0,120}unreleased candidate/i);
      expect(source, filePath).toMatch(/scheduled Beads Project sync[\s\S]{0,160}failed/i);
      expect(source, filePath).toMatch(/psyche-z7c\.4\.4[\s\S]{0,80}#230/);
      expect(source, filePath).not.toMatch(/(?:iOS|TestFlight)[^\n]{0,120}(?:now supported|internal beta is (?:live|available))/i);
    }
  });

  it('distinguishes historical Stage 0 proof from the current bypass-free policy', async () => {
    const documents = await Promise.all(
      ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of documents) {
      expect(source, filePath).toMatch(/administrator\s+enforcement/i);
      expect(source, filePath).toContain(pullUrl(351));
      expect(source, filePath).toContain('23cace08');
      expect(source, filePath).toMatch(/no\s+bypass\s+actors/i);
      expect(source, filePath).toMatch(/zero\s+required\s+approving\s+reviews/i);
      expect(source, filePath).toMatch(/direct-push\s+rejection\s+proof/i);
      expect(source, filePath).toMatch(/direct pushes[\s\S]{0,120}platform-blocked/i);
      expect(source, filePath).toMatch(/GitHub[\s\S]{0,100}(?:cannot|does not)[\s\S]{0,100}self-approval/i);
      expect(source, filePath).toMatch(/ordinary merges[\s\S]{0,100}no admin override/i);
      expect(source, filePath).not.toMatch(/all other actors require one approval/i);
      expect(source, filePath).not.toMatch(/uses the explicit PR-only bypass/i);
    }
  });

  it('separates published DMGs, the older Cask, and operator acceptance across public docs', async () => {
    for (const filePath of [
      'README.md',
      'docs/README.md',
      'docs/ROADMAP.md',
      'docs/POST-RELEASE-EXECUTION.md',
      'docs/SUPPORT-MATRIX.md',
      'docs/RELEASE-ACCEPTANCE.md',
    ]) {
      const source = await readFile(filePath, 'utf8');
      expect(source, filePath).toContain('https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.2');
      expect(source, filePath).toMatch(/Homebrew Cask[\s\S]{0,100}(?:still|remains)[\s\S]{0,50}`v0\.0\.1`/i);
      expect(source, filePath).toContain('33311851717');
    }
  });

  it('records delivered decomposition without treating it as stabilization closure', async () => {
    for (const filePath of ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md']) {
      const source = await readFile(filePath, 'utf8');
      for (const pull of [362, 366, 369, 370, 371, 372, 373]) {
        expect(source, filePath).toContain(pullUrl(pull));
      }
      expect(source, filePath).toMatch(/#196[\s\S]{0,100}reopened[\s\S]{0,80}2026-09-06/i);
      expect(source, filePath).toContain('terminal_state: incomplete');
      expect(source, filePath).not.toContain('still in design/inventory mode');
      expect(source, filePath).not.toContain('At reconciliation there is no open pull request');
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
    expect(beads).toMatch(
      /1,361 rows[\s\S]{0,240}bounded three-write audit gap[\s\S]{0,80}not an uninterrupted journal/i,
    );
    expect(beads).toMatch(/Use\s+plain\s+issue\s+references[\s\S]{0,120}generated\s+mirror/i);
    expect(beads).toMatch(
      /Never\s+place\s+any\s+GitHub-supported\s+closing\s+keyword[\s\S]{0,240}closed[\s\S]{0,240}before\s+a\s+generated\s+mirror\s+reference/i,
    );
    expect(beads).toMatch(
      /Publish\s+the\s+reviewed\s+Beads\s+source[\s\S]{0,80}then\s+let[\s\S]{0,80}protected\s+sync\s+reconcile\s+the\s+mirror/i,
    );
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

  it('retains the exact scheduled proof and bounded deviations for the Beads recovery', async () => {
    const unsafeMirrorReference =
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b.*(?:#230\b|https:\/\/github\.com\/OpenCoven\/psyche-build\/issues\/230\b)/i;
    const unsafeReferenceFixtures = [
      'Closes issue #230',
      'Closes the issue #230',
      'Fixes OpenCoven/psyche-build#230',
      'Resolved by [the generated mirror](https://github.com/OpenCoven/psyche-build/issues/230)',
      'Closes the generated mirror\n#230',
      `Closes ${'bounded context '.repeat(20)}#230`,
    ];
    for (const fixture of unsafeReferenceFixtures) {
      expect(fixture.replace(/\s+/g, ' ')).toMatch(unsafeMirrorReference);
    }

    const documents = await Promise.all(
      ['docs/ROADMAP.md', 'docs/POST-RELEASE-EXECUTION.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of documents) {
      const paragraphs = source
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.replace(/\s+/g, ' '));
      const closingKeywordBlocks = source
        .split(/\n\s*\n/)
        .flatMap((block) => (/^\s*\|/m.test(block) ? block.split('\n') : [block]))
        .map((block) => block.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const scheduledProof = paragraphs.find((paragraph) =>
        paragraph.includes(runUrl(33880014833)),
      );
      const auditGap = paragraphs.find((paragraph) =>
        /1,362\s+event rows/i.test(paragraph),
      );
      const publicationProvenance = paragraphs.find((paragraph) =>
        paragraph.includes('0at1pk83ng4ogm45svvp7ip122acgt4h'),
      );
      const reviewedProvenance = paragraphs.find((paragraph) =>
        paragraph.includes('l3c2l93j2iogl4h3ai947qls2vr10tbp'),
      );
      const mirrorDurability = paragraphs.find((paragraph) =>
        /Mirror #230 was regenerated after/.test(paragraph),
      );
      const pr350Deviation = paragraphs.find((paragraph) => /PR #350/.test(paragraph));

      expect(source, filePath).toContain(issueUrl(342));
      expect(source, filePath).toContain('9c85d2b79e3da16c283278824866a5ba1217950a');
      expect(source, filePath).toMatch(/schema v53/i);
      expect(auditGap, filePath).toMatch(
        /1,362\s+event rows.{0,180}1,361(?:-row|\s+rows).{0,120}(?:plus|and).{0,80}publication transition.{0,220}Three known post-ignore writes.{0,180}retain their commits and final source state.{0,180}(?:clone-local event rows are unavailable|not their clone-local event rows).{0,140}bounded three-write audit gap/i,
      );
      expect(scheduledProof, filePath).toMatch(
        /\[33880014833\]\(https:\/\/github\.com\/OpenCoven\/psyche-build\/actions\/runs\/33880014833\).{0,100}9e4a9cf383a1993ca2c2099e3d296acb3dd3c5b4.{0,100}(?:performed|performing) seven operations.{0,240}(?:validator|validation).{0,120}(?:exit|exited) `?0`?.{0,160}111 sources.{0,100}27 managed mirrors.{0,100}24 canonical outcomes.{0,80}0 findings/i,
      );
      expect(scheduledProof, filePath).toMatch(
        /\[33953178586\]\(https:\/\/github\.com\/OpenCoven\/psyche-build\/actions\/runs\/33953178586\).{0,100}23cace08fdc5e35e3ee0cd46200b4ed3bbd94131.{0,100}planned and applied 0 operations.{0,180}(?:(?:without|no) warnings or visibility drift|no warnings.{0,100}no visibility drift).{0,100}(?:retained|retaining) schema v53/i,
      );
      expect(mirrorDurability, filePath).toMatch(
        /Mirror #230.{0,160}authoritative source entered closed state.{0,240}never.{0,40}(?:manually )?edited/i,
      );
      expect(publicationProvenance, filePath).toMatch(
        /0at1pk83ng4ogm45svvp7ip122acgt4h`?\s*→\s*`?go64gshichpnsj3islhl6pmv5lgi2teb.{0,180}schema v53/i,
      );
      expect(reviewedProvenance, filePath).toMatch(
        /PR #346[^.]{0,120}reviewed[^.]{0,100}l3c2l93j2iogl4h3ai947qls2vr10tbp[^.]{0,180}(?:another|different) checkout[^.]{0,120}published[^.]{0,100}go64gshichpnsj3islhl6pmv5lgi2teb[^.]{0,180}exact-candidate gate did not hold/i,
      );
      expect(reviewedProvenance, filePath).toMatch(
        /Mirror #230[^.]{0,160}closed state[^.]{0,180}keyword syntax[^.]{0,120}(?:rather than|not through) the synchronizer/i,
      );
      expect(pr350Deviation, filePath).toMatch(
        /PR #350[^.]{0,180}(?:before the second qualifying|before the second scheduled)[^.]{0,160}(?:omitted this documentation contract|omitted the documentation-contract)/i,
      );
      for (const block of closingKeywordBlocks) {
        expect(block, filePath).not.toMatch(unsafeMirrorReference);
      }
    }
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
    expect(acceptance).toMatch(/\| \*\*Complete; corrected 2026-09-05\*\* \| \[#31\]/);
    expect(acceptance).toMatch(/Reusable recovery harness[\s\S]{0,160}\*\*Delivered on source only\*\*/);
    expect(acceptance).toMatch(/Operator-observed failure scenarios[\s\S]{0,160}\*\*Open post-release stabilization debt\*\*/);
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
