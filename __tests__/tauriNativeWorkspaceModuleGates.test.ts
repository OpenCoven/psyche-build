import { describe, expect, test } from 'vitest';
import {
  findGateViolations,
  parentImportsOf,
  importGateSatisfies,
  parentImports,
  resolvedGate,
  scannedModules,
} from './support/rustModuleGates.js';

/**
 * #197 slice 2 splits `native_workspace.rs` into child modules, and each split
 * replaces implicit access to the parent's items with explicit `use super::`
 * imports. An import whose `cfg` gate is looser than the declaration it names
 * is `error[E0432]`, but only on a platform or profile that excludes the
 * declaration — which is exactly the build the author is not running.
 *
 * #366 shipped `use super::PinnedDirectory;` against a `#[cfg(unix)]` type and
 * broke Windows; macOS and Linux both satisfy `cfg(unix)`, so no host check
 * could have caught it. #370 put two `#[cfg(test)]` imports in the ungated
 * group, and `cargo check` passed because it never builds `cfg(test)` code.
 *
 * The compiler is the real authority here. This test just moves the finding
 * off the CI runner that happens to have the right target and onto every
 * machine that runs the suite.
 */
describe('native workspace child module cfg gates', () => {
  test('no `use super::` import is looser than the declaration it names', () => {
    const violations = findGateViolations();
    const report = violations.map(
      (violation) => `${violation.child} imports \`${violation.item}\` under `
        + `[${violation.importGate}] but ${violation.parent} declares it under `
        + `[${violation.declarationGate}]`,
    );
    // Report the mismatches themselves; a bare count says nothing actionable.
    expect(report).toEqual([]);
  });

  test('an import gate may be narrower than the declaration, but never looser', () => {
    // Narrower is fine: an author may restrict an import further than the
    // declaration requires, and demanding an exact textual match would push
    // them to loosen a correct gate to quiet this contract.
    expect(importGateSatisfies('all(unix, test)', 'unix')).toBe(true);
    expect(importGateSatisfies('unix', 'unix')).toBe(true);

    // Looser is the defect: #366's ungated import of a `#[cfg(unix)]` type.
    expect(importGateSatisfies(undefined, 'unix')).toBe(false);
    expect(importGateSatisfies('test', 'unix')).toBe(false);
  });

  test('built-in cfg spellings for one condition are treated as equal', () => {
    // rustc sets `windows` for the same targets as `target_os = "windows"`,
    // and this crate uses both spellings — `lib.rs` the first, and
    // `browser_focus.rs` the second. Comparing them as unrelated atoms would
    // report a violation on code that compiles.
    expect(importGateSatisfies('target_os = "windows"', 'windows')).toBe(true);
    expect(importGateSatisfies('windows', 'target_os = "windows"')).toBe(true);
    expect(importGateSatisfies('target_family = "unix"', 'unix')).toBe(true);

    // `windows` does imply `not(unix)` here, which reverses what this test
    // asserted when it was written. The original reasoning — a target can be
    // neither — is true of Rust and false of this crate: every platform in
    // `Cargo.toml` is macOS, Linux, iOS or Windows, so exactly one of the two
    // holds. Enforcing the general rule made the contract report four correct
    // imports of `cfg`-paired functions as violations, and a check that flags
    // correct code stops being read.
    expect(importGateSatisfies('windows', 'not(unix)')).toBe(true);
    expect(importGateSatisfies('unix', 'not(windows)')).toBe(true);

    // Still not folded: an unrelated condition tells you nothing about either.
    expect(importGateSatisfies('test', 'unix')).toBe(false);
  });

  test('a parent may not import a child item under a looser gate', () => {
    // The direction that broke Windows in #387: the offending `use` lives in
    // `lib.rs`, not in the child, so scanning only child modules missed it.
    expect(importGateSatisfies('test', 'unix')).toBe(false);
    expect(importGateSatisfies('all(test, unix)', 'unix')).toBe(true);
  });

  test('an item declared once per platform is available on both', () => {
    // `coven_launch_session` is `#[cfg(unix)]` and `#[cfg(target_os =
    // "windows")]`. Reading only the first declaration reports an ungated
    // import of the pair as a violation; the union makes it available
    // everywhere this crate builds.
    expect(importGateSatisfies(undefined, 'any(unix, windows)')).toBe(true);
    expect(importGateSatisfies(undefined, 'unix')).toBe(false);
  });

  test('a re-export is checked like any other parent import', () => {
    // `native_workspace.rs` carries `pub(crate) use workspace_paths::…` so the
    // old call path keeps working. A `pub use` binds the child's item and
    // republishes it, so leaving it unscanned would miss the widest coupling
    // a parent can have on a child.
    expect(parentImportsOf('native_workspace.rs', 'workspace_paths'))
      .toContain('workspace_default_path');
  });

  test('the child modules under test are actually being scanned', () => {
    // A parser that silently matches nothing would pass the assertion above
    // forever. Pin the modules the contract currently covers.
    const scanned = scannedModules();
    expect(scanned).toContain('native_workspace/secure_fs.rs');
    expect(scanned).toContain('native_workspace/workspace_paths.rs');
    expect(scanned).toContain('native_workspace/workspace_restore.rs');
  });

  test('commented-out imports are not read as real ones', () => {
    // A block-commented `use super::Foo;` keeps its indentation, so it still
    // begins a line and a raw-text scan matches it. The contract would then
    // report a violation against code the compiler never compiles.
    //
    // `workspace_paths.rs` is the module that claims to borrow nothing from
    // its parent, which makes it the one where a phantom import is most
    // misleading, so it is the fixture here.
    expect(parentImports('native_workspace/workspace_paths.rs')).toEqual([]);
  });

  test('gated parent declarations are resolved, including awkward placements', () => {
    // `secure_fs` imports a `#[cfg(unix)]` type under a matching gate, and
    // `workspace_restore` imports `#[cfg(test)]` thread-locals whose gate sits
    // on the enclosing `thread_local!` block. Both resolve to a real gate, so
    // the scan is comparing predicates rather than skipping what it cannot find.
    expect(resolvedGate('native_workspace/secure_fs.rs', 'PinnedDirectory')).toBe('unix');
    expect(
      resolvedGate('native_workspace/workspace_restore.rs', 'TRUSTED_RESTORE_CANDIDATE_FAILURE'),
    ).toBe('test');
    expect(
      resolvedGate('native_workspace/workspace_restore.rs', 'RestoreCandidateFileOperation'),
    ).toBe('test');
  });
});
