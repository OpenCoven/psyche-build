import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const tauriRoot = join(
  repoRoot,
  'native/desktop/psyche-build-tauri/src-tauri'
);
const vendorRoot = join(tauriRoot, 'vendor');
const portablePtyRoot = join(vendorRoot, 'portable-pty');

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const tauriCargo = readFileSync(join(tauriRoot, 'Cargo.toml'), 'utf8');
const tauriLock = readFileSync(join(tauriRoot, 'Cargo.lock'), 'utf8');
const tauriLib = readFileSync(join(tauriRoot, 'src/lib.rs'), 'utf8');
const portableCargo = readIfPresent(join(portablePtyRoot, 'Cargo.toml'));
const portableLicense = readIfPresent(join(portablePtyRoot, 'LICENSE.md'));
const portableLib = readIfPresent(join(portablePtyRoot, 'src/lib.rs'));
const portableWin = readIfPresent(join(portablePtyRoot, 'src/win/mod.rs'));
const portableConpty = readIfPresent(
  join(portablePtyRoot, 'src/win/psuedocon.rs')
);
const portableAttributes = readIfPresent(
  join(portablePtyRoot, 'src/win/procthreadattr.rs')
);
const portableWinSupport = readIfPresent(
  join(portablePtyRoot, 'src/win_support.rs')
);

function packageBlock(lockfile: string, packageName: string): string {
  return (
    lockfile
      .split('[[package]]')
      .find((block) => block.includes(`name = "${packageName}"`)) ?? ''
  );
}

describe('vendored portable-pty Windows process-tree ownership', () => {
  it('uses only the exact local portable-pty 0.8.1 dependency', () => {
    expect(tauriCargo).toMatch(
      /portable-pty\s*=\s*\{\s*path\s*=\s*"vendor\/portable-pty",\s*version\s*=\s*"=0\.8\.1"\s*\}/
    );
    expect(portableCargo).toMatch(
      /\[package\][\s\S]*?name\s*=\s*"portable-pty"[\s\S]*?version\s*=\s*"0\.8\.1"/
    );

    const portableLock = packageBlock(tauriLock, 'portable-pty');
    expect(portableLock).toContain('version = "0.8.1"');
    expect(portableLock).not.toContain('source = ');
    expect(portableLock).not.toContain('checksum = ');

    const vendoredCrates = existsSync(vendorRoot)
      ? readdirSync(vendorRoot).sort()
      : [];
    expect(vendoredCrates).toEqual(['portable-pty']);
  });

  it('retains the upstream MIT license and copyright notice', () => {
    expect(existsSync(join(portablePtyRoot, 'LICENSE.md'))).toBe(true);
    expect(portableLicense).toContain('MIT License');
    expect(portableLicense).toContain('Copyright (c) 2018 Wez Furlong');
    expect(portableLicense).toContain(
      'The above copyright notice and this permission notice shall be included'
    );
  });

  it('creates and configures the kill-on-close job before CreateProcessW', () => {
    const spawnStart = portableConpty.indexOf('pub fn spawn_command');
    const spawnSource = portableConpty.slice(spawnStart);
    const createJob = spawnSource.indexOf('create_kill_on_close_job()');
    const createProcess = spawnSource.indexOf('CreateProcessW(');

    expect(spawnStart).toBeGreaterThanOrEqual(0);
    expect(createJob).toBeGreaterThanOrEqual(0);
    expect(createProcess).toBeGreaterThan(createJob);
    expect(portableConpty).toContain('CreateJobObjectW');
    expect(portableConpty).toContain('JobObjectExtendedLimitInformation');
    expect(portableConpty).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(portableConpty).toContain('SetInformationJobObject');

    const helperStart = portableConpty.indexOf('fn create_kill_on_close_job');
    const helperEnd = portableConpty.indexOf(
      'pub fn spawn_command',
      helperStart
    );
    const helperSource = portableConpty.slice(helperStart, helperEnd);
    expect(helperSource.indexOf('CreateJobObjectW')).toBeGreaterThanOrEqual(0);
    expect(helperSource.indexOf('SetInformationJobObject')).toBeGreaterThan(
      helperSource.indexOf('CreateJobObjectW')
    );
    expect(portableConpty).not.toContain('CREATE_SUSPENDED');
    expect(portableConpty).not.toContain('AssignProcessToJobObject');
  });

  it('supplies pseudoconsole and job-list attributes from live storage', () => {
    expect(portableWinSupport).toContain(
      'pub(crate) const WINDOWS_SPAWN_ATTRIBUTE_COUNT: u32 = 2;'
    );
    expect(portableAttributes).toContain(
      'PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE'
    );
    expect(portableAttributes).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST');
    expect(portableAttributes).toMatch(
      /pub fn set_job_list\([^)]*jobs:\s*&mut\s*\[HANDLE\]/
    );
    expect(portableAttributes).toContain('data: Vec<usize>');
    expect(portableConpty).toContain(
      'ProcThreadAttributeList::with_capacity(WINDOWS_SPAWN_ATTRIBUTE_COUNT)'
    );

    const spawnStart = portableConpty.indexOf('pub fn spawn_command');
    const spawnSource = portableConpty.slice(spawnStart);
    const jobStorage = spawnSource.indexOf('let mut job_handles = [');
    const setPty = spawnSource.indexOf('attrs.set_pty(self.con)');
    const setJobs = spawnSource.indexOf(
      'attrs.set_job_list(&mut job_handles)'
    );
    const createProcess = spawnSource.indexOf('CreateProcessW(');
    expect(jobStorage).toBeGreaterThanOrEqual(0);
    expect(setPty).toBeGreaterThan(jobStorage);
    expect(setJobs).toBeGreaterThan(setPty);
    expect(createProcess).toBeGreaterThan(setJobs);
  });

  it('retains job ownership in children and cloned killers', () => {
    expect(portableWin).toMatch(
      /pub struct WinChild\s*\{[\s\S]*?proc:\s*Mutex<OwnedHandle>,[\s\S]*?job:\s*Mutex<OwnedHandle>/
    );
    expect(portableWin).toMatch(
      /pub struct WinChildKiller\s*\{[\s\S]*?job:\s*OwnedHandle/
    );
    expect(portableWin).toMatch(
      /fn clone_killer\(&self\)[\s\S]*?self\.job\.lock\(\)\.unwrap\(\)\.try_clone\(\)\.unwrap\(\)[\s\S]*?WinChildKiller\s*\{\s*job\s*\}/
    );
    expect(portableConpty).toMatch(
      /Ok\(WinChild\s*\{[\s\S]*?proc:\s*Mutex::new\(proc\),[\s\S]*?job:\s*Mutex::new\(job\)/
    );
  });

  it('terminates jobs with correct Win32 BOOL success semantics', () => {
    expect(portableWin).toContain('TerminateJobObject');
    expect(portableWin).not.toContain('TerminateProcess');
    expect(portableWin).toMatch(
      /TerminateJobObject\([^;]+;\s*check_win32_bool\(\s*result,\s*"TerminateJobObject"\s*\)/
    );
    expect(portableWinSupport).toMatch(
      /if\s+result\s*!=\s*0\s*\{\s*Ok\(\(\)\)\s*\}\s*else\s*\{[\s\S]*?last_error/
    );
    const signallerStart = portableLib.indexOf(
      '#[cfg(windows)]\nimpl ChildKiller for ProcessSignaller'
    );
    const signallerEnd = portableLib.indexOf(
      '#[cfg(unix)]',
      signallerStart
    );
    const signallerSource = portableLib.slice(signallerStart, signallerEnd);
    expect(signallerSource).toContain('TerminateProcess');
    expect(signallerSource).toMatch(/==\s*0[\s\S]*?return\s+Err/);
  });

  it('returns explicit OS-context errors without an unowned fallback', () => {
    expect(portableConpty).toContain('CreateJobObjectW failed');
    expect(portableConpty).toContain(
      'SetInformationJobObject(JobObjectExtendedLimitInformation)'
    );
    expect(portableConpty).toMatch(
      /CreateProcessW `\{:\?\}` in cwd `\{:\?\}` failed: \{\}/
    );
    expect(portableConpty).not.toContain('AssignProcessToJobObject');
    expect(tauriLib).not.toContain('AssignProcessToJobObject');
    expect(tauriLib).not.toContain('CreateJobObjectW');
    expect(tauriLib).not.toContain('OpenProcess');
    expect(tauriLib).not.toContain('TerminateProcess');
  });
});
