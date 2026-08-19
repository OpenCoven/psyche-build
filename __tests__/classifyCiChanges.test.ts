import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const repoRoot = process.cwd()
const scriptPath = join(repoRoot, 'scripts', 'classify-ci-changes.sh')
const repos: string[] = []

function writeFiles(repoDir: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const full = join(repoDir, file)
    const dir = full.slice(0, full.lastIndexOf('/'))
    if (dir) execFileSync('mkdir', ['-p', dir])
    writeFileSync(full, content)
  }
}

function initRepo(baseFiles: Record<string, string>, headFiles: Record<string, string>) {
  const repoDir = mkdtempSync(join(repoRoot, 'classify-ci-'))
  repos.push(repoDir)
  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
  writeFiles(repoDir, baseFiles)
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } })
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()
  writeFiles(repoDir, headFiles)
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'head'], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z' } })
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()
  return { repoDir, baseSha, headSha }
}

function runClassifier(repoDir: string, baseSha: string, headSha: string, eventName: string, extraEnv: Record<string, string> = {}) {
  const outputFile = join(repoDir, 'github-output.txt')
  execFileSync('bash', [scriptPath], {
    cwd: repoDir,
    env: {
      ...process.env,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_OUTPUT: outputFile,
      ...extraEnv,
    },
  })
  const parsed: Record<string, string> = {}
  for (const line of execFileSync('cat', [outputFile], { cwd: repoDir }).toString().trim().split('\n').filter(Boolean)) {
    const [k, v] = line.split('=', 2)
    parsed[k] = v
  }
  return parsed
}

afterEach(() => {
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true })
})

describe('classify-ci-changes', () => {
  it('docs-only PR => desktop=false, ios=false', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'b\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({ desktop: 'false', ios: 'false' })
  })

  it('native/desktop change => desktop=true, ios=false', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'a\n', 'native/desktop/app.ts': 'x\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({ desktop: 'true', ios: 'false' })
  })

  it('shared src/daemon/protocol.ts => both true', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'a\n', 'src/daemon/protocol.ts': 'x\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({ desktop: 'true', ios: 'true' })
  })

  it('.github/workflows/ci.yml => both true', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'a\n', '.github/workflows/ci.yml': 'x\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({ desktop: 'true', ios: 'true' })
  })

  it('push event => both true', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'b\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'push')).toMatchObject({ desktop: 'true', ios: 'true' })
  })

  it('invalid base SHA => fail open, both true', () => {
    const { repoDir, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'b\n' })
    expect(runClassifier(repoDir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', headSha, 'pull_request')).toMatchObject({ desktop: 'true', ios: 'true' })
  })
})
