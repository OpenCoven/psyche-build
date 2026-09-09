import { describe, expect, test } from 'vitest';
import {
  desktopFunctionBody,
  desktopFunctionOwners,
} from './support/desktopRustSurface.js';

/**
 * The resolver behind the desktop contracts, tested directly.
 *
 * These contracts assert on Rust bodies, so a resolver that quietly returns
 * the wrong text is worse than one that throws: the assertion still runs, and
 * may still pass, against something that is not the function under test.
 */
describe('desktop Rust surface resolver', () => {
  test('skips bodiless declarations and resolves the real definition', () => {
    // `shutdown_write` appears twice in `coven_sessions.rs`: once as a trait
    // method signature ending in `;`, once as a braced implementation. Slicing
    // from the signature would find an unrelated `{` further down and return a
    // body that is not this function's.
    expect(desktopFunctionOwners('shutdown_write')).toEqual(['coven_sessions.rs']);

    const body = desktopFunctionBody('shutdown_write');
    expect(body).toMatch(/^\s*fn shutdown_write/u);
    expect(body).toContain('{');
    // A body sliced from the signature would swallow the rest of the trait and
    // run far past the function; a real one is small.
    expect(body.split('\n').length).toBeLessThan(30);
  });

  test('a trait signature alone does not make a file an owner', () => {
    // `sample` is declared as a trait method in `pty_transport.rs` and also
    // defined there with a body. The file must be listed once, not twice, and
    // a file holding only the signature must not be listed at all.
    const owners = desktopFunctionOwners('sample');
    expect(owners.filter((file) => file === 'pty_transport.rs')).toHaveLength(1);
    expect(new Set(owners).size).toBe(owners.length);

    // Genuinely ambiguous, so the resolver must refuse rather than pick one.
    expect(owners.length).toBeGreaterThan(1);
    expect(() => desktopFunctionBody('sample')).toThrow(/is defined in/u);
  });

  test('resolves a definition whose parameters span lines', () => {
    // `metrics.rs` writes `fn sample(` with the parameter list below it, so the
    // opening brace is not on the signature line. Requiring one there would
    // silently drop such definitions from the owner list.
    expect(desktopFunctionOwners('sample')).toContain('metrics.rs');
  });

  test('reports a missing function as a contract change, not a moved file', () => {
    expect(() => desktopFunctionBody('no_such_desktop_function')).toThrow(
      /no braced definition/u,
    );
  });

  test('finds functions inside child modules, not just top-level files', () => {
    // Slice 2 moved these under `native_workspace/`; slice 3 will do the same
    // for the PTY subsystem. A flat scan would stop seeing them.
    expect(desktopFunctionOwners('open_workspace_lock')).toEqual([
      'native_workspace/secure_fs.rs',
    ]);
  });
});
