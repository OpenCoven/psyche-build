import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the desktop Rust surface that contract tests assert against, without
 * depending on which file holds the composition root.
 *
 * Several tests assert the exact `tauri::generate_handler!` registration
 * alongside the command bodies it registers. Those assertions are about the
 * IPC contract, not about file layout, but they previously read `lib.rs` by
 * path. That coupling makes a pure relocation of `run()` look like a contract
 * break, which is backwards: a test should fail when a command disappears, not
 * when the wiring moves.
 *
 * Returning `lib.rs` together with whichever file registers the commands keeps
 * both kinds of assertion pointed at the contract, so #197's extraction slices
 * do not require editing every safety net that depends on them.
 */

const SRC_DIRECTORY = 'native/desktop/psyche-build-tauri/src-tauri/src';
const REGISTRATION_MARKER = 'tauri::generate_handler!';

export function readDesktopCommandSurface(): string {
  const directory = resolve(process.cwd(), SRC_DIRECTORY);
  const entries = readdirSync(directory).filter((entry) => entry.endsWith('.rs')).sort();

  const sources = new Map<string, string>();
  for (const entry of entries) {
    // Normalize line endings. Several callers slice Rust source with
    // `indexOf('\n}\n')`, and `.gitattributes` does not pin `*.rs` to LF, so a
    // CRLF checkout would make those slices silently miss. Assertions here are
    // about Rust structure, never about line-ending bytes.
    sources.set(
      entry,
      readFileSync(resolve(directory, entry), 'utf8').replace(/\r\n/gu, '\n'),
    );
  }

  const registrations = [...sources.entries()]
    .filter(([, source]) => source.includes(REGISTRATION_MARKER));

  if (registrations.length === 0) {
    throw new Error(`no ${REGISTRATION_MARKER} registration found under ${SRC_DIRECTORY}`);
  }
  if (registrations.length > 1) {
    // Two composition roots would mean two IPC surfaces, and an assertion
    // satisfied by either would not prove the shipped one is correct.
    const names = registrations.map(([name]) => name).join(', ');
    throw new Error(
      `expected exactly one ${REGISTRATION_MARKER} registration under ${SRC_DIRECTORY}, found: ${names}`,
    );
  }

  const lib = sources.get('lib.rs');
  if (lib === undefined) throw new Error(`${SRC_DIRECTORY}/lib.rs is missing`);

  const [registrationName, registrationSource] = registrations[0];
  // While `run()` still lives in lib.rs these are the same file; return it once
  // so concatenation cannot make a single occurrence look like two.
  return registrationName === 'lib.rs' ? lib : `${lib}\n${registrationSource}`;
}
