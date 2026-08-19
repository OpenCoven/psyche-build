import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const repoRoot = process.cwd()
const scriptPath = join(repoRoot, 'scripts', 'classify-ci-changes.sh')
const repos: string[] = []

function writeFiles(repoDir: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const full = join(repoDir, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

function initRepo(
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>,
  mutate?: (repoDir: string) => void,
) {
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
  mutate?.(repoDir)
  execFileSync('git', ['add', '--all'], { cwd: repoDir })
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
  for (const line of readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean)) {
    const [k, v] = line.split('=', 2)
    parsed[k] = v
  }
  return parsed
}

afterEach(() => {
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true })
})

describe('classify-ci-changes', () => {
  it('docs-only PR => desktop=false, ios=false, package=false', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/notes.md': 'a\n' }, { 'docs/notes.md': 'b\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'false',
      ios: 'false',
      package: 'false',
    })
  })

  it('native/desktop change => desktop=true, ios=false', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'a\n', 'native/desktop/app.ts': 'x\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({ desktop: 'true', ios: 'false' })
  })

  it('frontend-only change => desktop=true, ios=false, package=true', () => {
    const { repoDir, baseSha, headSha } = initRepo(
      { 'docs/readme.md': 'a\n' },
      { 'docs/readme.md': 'a\n', 'frontend/src/dashboard.ts': 'x\n' },
    )
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'true',
      ios: 'false',
      package: 'true',
    })
  })

  it('native/ios change => desktop=false, ios=true, package=false', () => {
    const { repoDir, baseSha, headSha } = initRepo(
      { 'docs/readme.md': 'a\n' },
      { 'docs/readme.md': 'a\n', 'native/ios/PsycheApp/App.swift': 'x\n' },
    )
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'false',
      ios: 'true',
      package: 'false',
    })
  })

  it('shared src/daemon/protocol.ts => both true', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'a\n', 'src/daemon/protocol.ts': 'x\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({ desktop: 'true', ios: 'true' })
  })

  it.each([
    'src/services/bridge/wireProtocol.ts',
    'src/actions/types.ts',
    'src/workspace/snapshot.ts',
    'src/utils/fileBrowser.ts',
  ])('shared mobile contract path %s => both native tiers true', (path) => {
    const { repoDir, baseSha, headSha } = initRepo(
      { 'docs/readme.md': 'a\n' },
      { 'docs/readme.md': 'a\n', [path]: 'x\n' },
    )
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({
      desktop: 'true',
      ios: 'true',
    })
  })

  it('.github/workflows/ci.yml => desktop=true, ios=true, package=true', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'a\n', '.github/workflows/ci.yml': 'x\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'true',
      ios: 'true',
      package: 'true',
    })
  })

  it.each([
    'vitest.config.ts',
    'vitest.smoke.config.ts',
  ])('root Vitest config %s => desktop=true, ios=false, package=false', (path) => {
    const { repoDir, baseSha, headSha } = initRepo(
      { 'docs/readme.md': 'a\n' },
      { 'docs/readme.md': 'a\n', [path]: 'export default {}\n' },
    )
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'true',
      ios: 'false',
      package: 'false',
    })
  })

  it('editing scripts/classify-ci-changes.sh => desktop=true, ios=true, package=true', () => {
    const { repoDir, baseSha, headSha } = initRepo(
      { 'docs/readme.md': 'a\n' },
      { 'docs/readme.md': 'a\n', 'scripts/classify-ci-changes.sh': '#!/usr/bin/env bash\n' },
    )
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'true',
      ios: 'true',
      package: 'true',
    })
  })

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'scripts/release-version.mjs',
    'src/index.ts',
    'frontend/src/components/Dashboard.vue',
    'packages/vim-core/src/index.ts',
    'src/control-task-tokens.ts',
    'src/utils/generated-agents-doc.ts',
    'README.md',
    'docs/README.md',
    'docs/INTEGRATIONS.md',
  ])('package-affecting path %s requires package smoke', (path) => {
    const { repoDir, baseSha, headSha } = initRepo(
      { 'docs/notes.md': 'a\n' },
      { 'docs/notes.md': 'a\n', [path]: 'changed\n' },
    )
    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request'), path)
      .toMatchObject({ package: 'true' })
  })

  it('renaming a native iOS file into docs still selects iOS', () => {
    const oldPath = 'native/ios/PsycheApp/Sources/App.swift'
    const newPath = 'docs/renamed-notes.md'
    const { repoDir, baseSha, headSha } = initRepo(
      { [oldPath]: 'let value = 1\n' },
      {},
      (repo) => {
        mkdirSync(dirname(join(repo, newPath)), { recursive: true })
        execFileSync('git', ['mv', oldPath, newPath], { cwd: repo })
      },
    )

    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toEqual({
      desktop: 'false',
      ios: 'true',
      package: 'false',
    })
  })

  it('classifies both sides of a rename with Unicode and newline paths', () => {
    const oldPath = 'native/ios/PsycheApp/Sources/Old.swift'
    const newPath = 'docs/renamed 魔法\nnotes.md'
    const oldNative = initRepo(
      { [oldPath]: 'let value = 1\n' },
      {},
      (repo) => {
        mkdirSync(dirname(join(repo, newPath)), { recursive: true })
        renameSync(join(repo, oldPath), join(repo, newPath))
      },
    )

    expect(runClassifier(
      oldNative.repoDir,
      oldNative.baseSha,
      oldNative.headSha,
      'pull_request',
    )).toMatchObject({
      ios: 'true',
    })

    const oldDocsPath = 'docs/old 魔法\nnotes.md'
    const newDesktopPath = 'native/desktop/psyche-build-tauri/src-tauri/src/New.rs'
    const newNative = initRepo(
      { [oldDocsPath]: 'notes\n' },
      {},
      (repo) => {
        mkdirSync(dirname(join(repo, newDesktopPath)), { recursive: true })
        renameSync(join(repo, oldDocsPath), join(repo, newDesktopPath))
      },
    )

    expect(runClassifier(
      newNative.repoDir,
      newNative.baseSha,
      newNative.headSha,
      'pull_request',
    )).toMatchObject({
      desktop: 'true',
    })
  })

  it('classifies deleted native paths', () => {
    const deletedPath = 'native/desktop/psyche-build-tauri/src-tauri/src/deleted.rs'
    const { repoDir, baseSha, headSha } = initRepo(
      { [deletedPath]: 'fn deleted() {}\n' },
      {},
      (repo) => unlinkSync(join(repo, deletedPath)),
    )

    expect(runClassifier(repoDir, baseSha, headSha, 'pull_request')).toMatchObject({
      desktop: 'true',
    })
  })

  it('push event => every tier true', () => {
    const { repoDir, baseSha, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'b\n' })
    expect(runClassifier(repoDir, baseSha, headSha, 'push')).toEqual({
      desktop: 'true',
      ios: 'true',
      package: 'true',
    })
  })

  it('initial push with zero before SHA => every tier true', () => {
    const { repoDir, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'b\n' })
    expect(runClassifier(repoDir, '0000000000000000000000000000000000000000', headSha, 'push')).toEqual({
      desktop: 'true',
      ios: 'true',
      package: 'true',
    })
  })

  it('invalid base SHA => fail open, every tier true', () => {
    const { repoDir, headSha } = initRepo({ 'docs/readme.md': 'a\n' }, { 'docs/readme.md': 'b\n' })
    expect(runClassifier(repoDir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', headSha, 'pull_request')).toEqual({
      desktop: 'true',
      ios: 'true',
      package: 'true',
    })
  })
})
