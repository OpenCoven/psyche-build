import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the desktop Rust surface that the native workspace security contract
 * asserts against, without depending on which file holds a given function.
 *
 * `tauriNativeWorkspaceSecurity.test.ts` asserts the bodies of 24 functions
 * spanning every concern in `native_workspace.rs` — filesystem primitives,
 * locking, publication, restore, and recovery decisions. Those assertions are
 * about symlink and TOCTOU defences, not about file layout, but they read one
 * file by path. #197 slice 2 splits that module, so every extraction step
 * would otherwise appear to break the security contract.
 *
 * Reading the whole module directory keeps each assertion pointed at the
 * defence it guards while the code moves beneath it.
 */

const SRC_DIRECTORY = 'native/desktop/psyche-build-tauri/src-tauri/src';

/** Free functions only; impl methods are indented and may legitimately repeat. */
const FREE_FUNCTION = /^(?:pub(?:\([a-z()]+\))? )?(?:unsafe )?(?:async )?fn ([a-z_0-9]+)/gmu;

export function readNativeWorkspaceSurface(): string {
  return loadModules().sources.join('\n');
}

/**
 * Fails when a name the security contract asserts is defined in more than one
 * module, because a body assertion would then match an arbitrary definition.
 *
 * Only asserted names are checked. Several helpers legitimately share a name
 * across modules today — `c_name` exists in both `lib.rs` and
 * `native_workspace.rs` — and guarding every free function would reject the
 * repository as it already stands rather than catching a real regression.
 */
export function assertUnambiguousFunction(name: string): void {
  const { owners } = loadModules();
  const files = owners.get(name) ?? [];
  if (files.length > 1) {
    throw new Error(
      `free function \`${name}\` is defined in ${files.join(' and ')}; `
      + 'the security contract cannot identify which body it is asserting',
    );
  }
}

/**
 * Rust sources under `directory`, recursively, as paths relative to it.
 *
 * #197 slice 2 moves functions into child modules such as
 * `native_workspace/secure_fs.rs`. A flat scan would stop seeing those bodies
 * the moment they moved, so the security contract would report a missing
 * function instead of an unguarded one — a failure that looks like a broken
 * test rather than a broken defence.
 */
function rustFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...rustFilesUnder(resolve(directory, entry.name)).map((n) => `${entry.name}/${n}`));
    } else if (entry.name.endsWith('.rs')) {
      found.push(entry.name);
    }
  }
  return found;
}

let cached: { sources: string[]; owners: Map<string, string[]> } | undefined;

/**
 * Parsed once per process. The contract calls `functionBody` roughly two dozen
 * times, and re-reading every module each time would re-parse `lib.rs` alone
 * on every call. Test files do not change mid-run, so a process-lifetime cache
 * is safe.
 */
function loadModules(): { sources: string[]; owners: Map<string, string[]> } {
  if (cached !== undefined) return cached;
  const directory = resolve(process.cwd(), SRC_DIRECTORY);
  const entries = rustFilesUnder(directory).sort();

  const owners = new Map<string, string[]>();
  const sources: string[] = [];
  for (const entry of entries) {
    // Normalize line endings: callers slice bodies by brace matching, and
    // `.gitattributes` does not pin `*.rs` to LF.
    const source = readFileSync(resolve(directory, entry), 'utf8').replace(/\r\n/gu, '\n');
    sources.push(source);
    for (const match of source.matchAll(FREE_FUNCTION)) {
      const files = owners.get(match[1]) ?? [];
      // Two definitions in one file are `cfg`-gated platform variants, which
      // is ordinary Rust; only distinct files make a name ambiguous.
      if (!files.includes(entry)) files.push(entry);
      owners.set(match[1], files);
    }
  }
  cached = { sources, owners };
  return cached;
}
