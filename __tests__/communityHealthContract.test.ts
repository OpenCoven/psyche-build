import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const requiredFiles = [
  'SECURITY.md',
  'SUPPORT.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'docs/CONTRIBUTOR-SAFETY.md',
  'docs/superpowers/README.md',
  '.github/CODEOWNERS',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/documentation.yml',
  'docs/COMMUNITY-HEALTH.md',
];

describe('community health contract', () => {
  it('keeps the required security, ownership, support, conduct, and intake files present', () => {
    for (const path of requiredFiles) {
      expect(read(path).trim().length, `${path} should not be empty`).toBeGreaterThan(0);
    }
  });

  it('provides one private vulnerability route and prevents blank public intake', () => {
    const security = read('SECURITY.md');
    const support = read('SUPPORT.md');
    const config = read('.github/ISSUE_TEMPLATE/config.yml');
    const privateRoute = 'https://github.com/OpenCoven/psyche-build/security/advisories/new';

    expect(security).toContain(privateRoute);
    expect(support).toContain(privateRoute);
    expect(config).toContain(privateRoute);
    expect(config).toMatch(/blank_issues_enabled:\s*false/);
    expect(config).toMatch(/Never disclose vulnerability details in a public issue/i);
    expect(security).toMatch(/Do not open a public issue, pull request, discussion, or Bead/i);
  });

  it('keeps the bug-form recovery-impact question optional and recovery-focused', () => {
    const bug = read('.github/ISSUE_TEMPLATE/bug.yml');
    const start = bug.indexOf('id: recovery_impact');
    expect(start).toBeGreaterThan(-1);
    const nextField = bug.indexOf('- type:', start);
    const field = bug.slice(start, nextField === -1 ? undefined : nextField);
    expect(field).toMatch(/Recovery impact/i);
    expect(field).toMatch(/required:\s*false/);
    expect(field).toMatch(/not applicable/i);
  });

  it('records the community-health status without weakening intake boundaries', () => {
    const record = read('docs/COMMUNITY-HEALTH.md');
    expect(record).toContain(
      'gh api repos/OpenCoven/psyche-build/community/profile',
    );
    expect(record).toMatch(/Settings.*Moderation options.*Reported content/is);
    expect(record).not.toMatch(
      /(?:paste|attach|upload|provide|include) .{0,80}(?:token|password|private key|raw prompt|terminal output)/i,
    );
  });

  it('routes public reports through bounded forms tied to current support policy', () => {
    const support = read('SUPPORT.md');
    expect(support).toContain('docs/SUPPORT-MATRIX.md');
    expect(support).toContain('docs/ROADMAP.md');
    expect(support).toContain('docs/CONTRIBUTOR-SAFETY.md');

    for (const path of [
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/ISSUE_TEMPLATE/feature.yml',
      '.github/ISSUE_TEMPLATE/documentation.yml',
    ]) {
      const form = read(path);
      expect(form).toMatch(/^name:/m);
      expect(form).toMatch(/^description:/m);
      expect(form).toMatch(/^body:/m);
      expect(form).toMatch(/public/i);
      expect(form).toMatch(/support matrix|SUPPORT\.md|roadmap/i);
    }
  });

  it('does not solicit dangerous material in public templates', () => {
    const publicTemplates = [
      '.github/pull_request_template.md',
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/ISSUE_TEMPLATE/feature.yml',
      '.github/ISSUE_TEMPLATE/documentation.yml',
    ].map(read);

    const unsafeSolicitations = [
      /(?:please|required to|must)\s+(?:paste|attach|upload|provide|include).{0,80}(?:token|password|private key|certificate|signing material)/i,
      /(?:please|required to|must)\s+(?:paste|attach|upload|provide|include).{0,80}(?:raw prompt|private repository|complete environment|full environment)/i,
      /(?:please|required to|must)\s+(?:paste|attach|upload|provide|include).{0,80}(?:unrestricted terminal|command history|private service url|unredacted path)/i,
    ];

    for (const template of publicTemplates) {
      expect(template).toMatch(/do not|contains no|removed or replaced/i);
      for (const pattern of unsafeSolicitations) {
        expect(template).not.toMatch(pattern);
      }
    }
  });

  it('requires owners for repository-wide and high-risk surfaces', () => {
    const codeowners = read('.github/CODEOWNERS');
    for (const pattern of [
      '* @BunsDev',
      '/.github/ @BunsDev',
      '/src/control/ @BunsDev',
      '/src/services/bridge/ @BunsDev',
      '/protocol-fixtures/ @BunsDev',
      '/native/desktop/psyche-build-tauri/src-tauri/ @BunsDev',
      '/native/ios/ @BunsDev',
      '/.beads/ @BunsDev',
      '/scripts/beads-project-sync/ @BunsDev',
    ]) {
      expect(codeowners).toContain(pattern);
    }
  });

  it('distinguishes generated-source commands from production evidence', () => {
    const safety = read('docs/CONTRIBUTOR-SAFETY.md');
    const pullRequest = read('.github/pull_request_template.md');

    for (const command of [
      'pnpm generate:hooks-docs',
      'pnpm --dir native/desktop/psyche-build-tauri build:web',
      'pnpm ios:project:generate',
      'pnpm ios:project:check',
      'pnpm build',
    ]) {
      expect(safety).toContain(command);
    }

    expect(safety).toMatch(/Do not convert a unit-test count into a user-path claim/i);
    expect(safety).toMatch(/Do not convert source presence into platform support/i);
    expect(safety).toMatch(/simulator build into physical-device availability/i);
    expect(pullRequest).toContain('docs/RELEASE-ACCEPTANCE.md');
    expect(pullRequest).toMatch(/test counts, source presence, hosted compilation, or simulator success/i);
  });

  it('makes PR scope, design escalation, and evidence expectations explicit', () => {
    const contributing = read('CONTRIBUTING.md');

    expect(contributing).toMatch(/approximately \*\*800 non-generated changed lines\*\*/i);
    expect(contributing).toMatch(/design\/ADR \*\*before implementation\*\*/i);
    expect(contributing).toMatch(/Git 2\.20 or newer/i);
    expect(contributing).toContain('corepack enable && corepack prepare');
    expect(contributing).toContain('bash ./scripts/agent-bootstrap');
    expect(contributing).toContain('bash ./scripts/agent-check fast');
    expect(contributing).toContain('bash ./scripts/agent-check full');
    expect(contributing).toMatch(/required exact-head GitHub checks must succeed/i);
    expect(contributing).toMatch(/unresolved current review threads\/findings/i);
    expect(contributing).toMatch(/Objective and acceptance criteria/i);
    expect(contributing).toMatch(/Authority\/security impact/i);
    expect(contributing).toMatch(/Remaining uncertainty/i);
  });

  it('keeps dated superpowers records historical by default', () => {
    const history = read('docs/superpowers/README.md');

    expect(history).toContain('docs/superpowers/plans/*.md');
    expect(history).toContain('docs/superpowers/specs/*.md');
    expect(history).toMatch(/classified \*\*`reference`\*\*/i);
    expect(history).toMatch(/not.*executable backlog/i);
    expect(history).toContain('active');
    expect(history).toContain('implemented');
    expect(history).toContain('superseded');
    expect(history).toContain('reference');
    expect(history).toMatch(/Do not rewrite the historical document/i);
  });
});
