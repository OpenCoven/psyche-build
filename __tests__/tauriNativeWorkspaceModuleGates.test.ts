import { describe, expect, test } from 'vitest';
import {
  findGateViolations,
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
