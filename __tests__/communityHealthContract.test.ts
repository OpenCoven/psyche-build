import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string): Promise<string> => readFile(path, 'utf8');

const publicDataWarning =
  /access tokens|secrets[\s\S]*private (?:project|repository|user) (?:data|content)/i;

describe('repository community and security floor', () => {
  it('publishes support and private vulnerability reporting boundaries', async () => {
    const [security, support] = await Promise.all([
      read('SECURITY.md'),
      read('SUPPORT.md'),
    ]);

    expect(security).toContain('/security/advisories/new');
    expect(security).toMatch(/Do \*\*not\*\* open a public issue/i);
    expect(security).toContain('Latest stable macOS release');
    expect(security).toMatch(/iOS companion[\s\S]*not currently supported/i);
    expect(security).toMatch(/task-bound authentication|capability leases/i);
    expect(security).toMatch(publicDataWarning);

    expect(support).toContain('docs/SUPPORT-MATRIX.md');
    expect(support).toContain('one-way sanitized mirror');
    expect(support).toContain('follow `SECURITY.md` and report privately');
    expect(support).toMatch(publicDataWarning);
    expect(support).toMatch(/best-effort[\s\S]*does not include an SLA/i);
  });

  it('defines review ownership for authority, release, native, and generated surfaces', async () => {
    const owners = await read('.github/CODEOWNERS');

    for (const path of [
      '/.github/workflows/',
      '/src/control/',
      '/src/services/bridge/',
      '/native/desktop/psyche-build-tauri/src-tauri/',
      '/native/ios/',
      '/scripts/beads-project-sync/',
      '/.beads/',
      '/protocol-fixtures/',
      '/src/utils/generated-agents-doc.ts',
      '/native/ios/Psyche.xcodeproj/',
    ]) {
      expect(owners).toContain(path);
    }

    expect(owners).toMatch(/^\* @BunsDev/m);
  });

  it('requires evidence, authority analysis, recovery, and redaction in pull requests', async () => {
    const template = await read('.github/pull_request_template.md');

    for (const heading of [
      '## Objective',
      '## Tracking',
      '## Canonical contracts consulted',
      '## Verification evidence',
      '## Authority, security, and privacy',
      '## Migration and rollback',
      '## Generated artifacts',
      '## Remaining uncertainty',
    ]) {
      expect(template).toContain(heading);
    }

    expect(template).toContain('exact PR head');
    expect(template).toContain('R3/R4');
    expect(template).toMatch(publicDataWarning);
  });

  it('keeps public issue forms redacted and redirects security reports privately', async () => {
    const paths = [
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/ISSUE_TEMPLATE/feature.yml',
      '.github/ISSUE_TEMPLATE/documentation.yml',
    ];
    const forms = await Promise.all(paths.map(read));

    for (const [index, form] of forms.entries()) {
      expect(form, paths[index]).toContain('This issue is public');
      expect(form, paths[index]).toMatch(/Do not include|Do not paste/i);
      expect(form, paths[index]).toMatch(/private (?:project|repository)/i);
      expect(form, paths[index]).toContain('required: true');
      expect(form, paths[index]).not.toContain('BEADS_PROJECT_TOKEN=');
      expect(form, paths[index]).not.toContain('PSYCHE_CONTROL_TASK_TOKEN=');
    }

    const config = await read('.github/ISSUE_TEMPLATE/config.yml');
    expect(config).toContain('blank_issues_enabled: false');
    expect(config).toContain('name: Private security report');
    expect(config).toContain('/security/advisories/new');
    expect(config).toMatch(/Do not disclose vulnerabilities/i);
  });

  it('sets enforceable conduct expectations without inviting public incident details', async () => {
    const conduct = await read('CODE_OF_CONDUCT.md');

    expect(conduct).toContain('## Our standard');
    expect(conduct).toContain('## Scope');
    expect(conduct).toContain('## Reporting and enforcement');
    expect(conduct).toMatch(/Do not post\s+names, screenshots, private messages/i);
    expect(conduct).toMatch(/warning[\s\S]*restrict participation[\s\S]*permanently exclude/i);
    expect(conduct).toMatch(/Good-faith reports and appeals must not be punished/i);
  });
});