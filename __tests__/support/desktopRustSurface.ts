import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolves a Rust function by name to the file that defines it, so contract
 * assertions survive #197's extraction slices.
 *
 * Several desktop contracts slice a function body out of `lib.rs` and assert
 * on it — that the PTY commands check the calling webview, that a launch
 * scrubs inherited environment, and so on. They read `lib.rs` by path, so
 * moving a guarded function to a sibling module makes them fail with *function
 * not found*: a missing function reported where the risk is an unguarded one.
 * Those two failures need to look different, because only one of them is a
 * security regression.
 *
 * This resolves the name instead of the path. `nativeWorkspaceSurface.ts`
 * solved the same problem for slice 2 in #364 by concatenating a module
 * directory, which does not work here: the desktop surface has many duplicate
 * free-function names across files (`c_name`, `browser_script`,
 * `default_shell` and more), and the loader's existing consumers carry over two
 * hundred negative assertions that a wider source would flip. Resolving one
 * name to one file avoids both.
 */

const SRC_DIRECTORY = 'native/desktop/psyche-build-tauri/src-tauri/src';

/** Free functions and methods; `fn` may be preceded by visibility and qualifiers. */
const definition = (name: string): RegExp =>
  new RegExp(`^[ \\t]*(?:pub(?:\\([a-z():]+\\))? )?(?:const )?(?:unsafe )?(?:async )?fn ${name}\\b`, 'mu');

/**
 * The body of `name`, from its signature to its closing brace.
 *
 * Throws when the name is defined in no file or in more than one, rather than
 * returning an arbitrary match. An assertion satisfied by whichever definition
 * happened to be found first would not prove the shipped one is correct.
 */
export function desktopFunctionBody(name: string): string {
  const owners = desktopFunctionOwners(name);
  if (owners.length === 0) {
    throw new Error(
      `no definition of \`fn ${name}\` under ${SRC_DIRECTORY}; `
      + 'the function was renamed or removed, which is a contract change rather than a moved file',
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `\`fn ${name}\` is defined in ${owners.join(' and ')}; `
      + 'this contract cannot tell which body it is asserting',
    );
  }
  const source = read(owners[0]);
  const start = definition(name).exec(source)?.index ?? -1;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced braces while reading \`fn ${name}\` from ${owners[0]}`);
}

/** Files defining `name`, relative to the source directory. Exported for contract self-checks. */
export function desktopFunctionOwners(name: string): string[] {
  const pattern = definition(name);
  return rustFiles().filter((file) => pattern.test(read(file)));
}

let files: string[] | undefined;
let sources: Map<string, string> | undefined;

/** Rust sources under the desktop crate, recursively, relative to `SRC_DIRECTORY`. */
function rustFiles(): string[] {
  if (files !== undefined) return files;
  const root = resolve(process.cwd(), SRC_DIRECTORY);
  const walk = (directory: string, prefix: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Recursive: slice 2 put ten modules under `native_workspace/`, and slice
      // 3 will do the same. A flat scan stops seeing a body the moment it moves.
      if (entry.isDirectory()) found.push(...walk(resolve(directory, entry.name), `${prefix}${entry.name}/`));
      else if (entry.name.endsWith('.rs')) found.push(`${prefix}${entry.name}`);
    }
    return found;
  };
  files = walk(root, '');
  return files;
}

function read(file: string): string {
  if (sources === undefined) sources = new Map();
  const cached = sources.get(file);
  if (cached !== undefined) return cached;
  // `.gitattributes` does not pin `*.rs` to LF, and callers slice by brace
  // depth; a CRLF checkout must not change what a body looks like.
  const source = readFileSync(resolve(process.cwd(), SRC_DIRECTORY, file), 'utf8').replace(/\r\n/gu, '\n');
  sources.set(file, source);
  return source;
}

/**
 * The full text of the file defining `name`.
 *
 * Some contracts assert on text adjacent to a function rather than inside it —
 * that `#[tauri::command]` sits directly above a signature, for instance. A
 * body slice starts at `fn` and cannot see that, so those assertions need the
 * owning file rather than the body, while still resolving by name.
 */
export function desktopSourceDefining(name: string): string {
  const owners = desktopFunctionOwners(name);
  if (owners.length !== 1) {
    throw new Error(
      `expected exactly one definition of \`fn ${name}\` under ${SRC_DIRECTORY}, found: `
      + `${owners.join(', ') || 'none'}`,
    );
  }
  return read(owners[0]);
}
