import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const issueUrl = (issue: number): string =>
  `https://github.com/OpenCoven/psyche-build/issues/${issue}`;

const pullUrl = (pull: number): string =>
  `https://github.com/OpenCoven/psyche-build/pull/${pull}`;

describe('post-release execution documentation', () => {
  it('names the complete critical path without changing support claims', async () => {
    const execution = await readFile('docs/POST-RELEASE-EXECUTION.md', 'utf8');

    for (const issue of [31, 195, 196, 198, 199, 200, 201, 237, 238, 239, 240, 241, 242, 243, 244]) {
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
    expect(execution).toMatch(/No listed active implementation PR is merge-ready/i);
    expect(roadmap).toMatch(/No active implementation PR above is merge-ready/i);
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
