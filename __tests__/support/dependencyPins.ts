import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reads a dependency pin from the one file that declares it.
 *
 * Contract tests used to repeat the pinned value: an action's commit, an npm
 * version, a Cargo requirement, the Rust channel. Every automated update then
 * failed until someone edited the test to the same new value, which proved
 * nothing the manifest did not already say. These helpers keep what the tests
 * were for: the dependency is declared, the pin has the exact form the
 * repository requires, and every place that repeats it agrees.
 *
 * Each helper throws with the reason when a pin is missing or malformed, so a
 * test cannot pass by reading nothing.
 */

const COMMIT = /^[0-9a-f]{40}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const CARGO_REQUIREMENT = /^\d+(?:\.\d+){0,2}$/;

/** One third-party `uses:` reference in a workflow or composite action. */
export interface ActionUse {
  file: string;
  action: string;
  ref: string;
  /** Text after `#` on the same line, or '' when there is none. */
  comment: string;
}

/** Every third-party `uses:` in the given sources. Local `./` actions are skipped. */
export function actionUses(sources: ReadonlyArray<readonly [string, string]>): ActionUse[] {
  return sources.flatMap(([file, source]) =>
    [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#@]+)@([^\s#]+)(?:[ \t]+#[ \t]*(.*))?$/gm)]
      .filter(([, action]) => !action.startsWith('./'))
      .map(([, action, ref, comment]) => ({
        file: path.basename(file),
        action,
        ref,
        comment: (comment ?? '').trim(),
      })),
  );
}

/**
 * The commit an action is pinned to in the given sources.
 *
 * Throws unless the action is used at least once, every use names a full
 * commit SHA followed by a version comment, and all uses name the same commit.
 */
export function pinnedActionCommit(
  sources: ReadonlyArray<readonly [string, string]>,
  action: string,
): string {
  const uses = actionUses(sources).filter((use) => use.action === action);
  if (uses.length === 0) {
    throw new Error(`${action} is not used in ${sources.map(([file]) => path.basename(file)).join(', ')}`);
  }
  for (const use of uses) {
    if (!COMMIT.test(use.ref)) {
      throw new Error(`${use.file}: ${action}@${use.ref} is not pinned to a full commit SHA`);
    }
    if (use.comment === '') {
      throw new Error(`${use.file}: ${action}@${use.ref} has no trailing version comment`);
    }
  }
  const commits = [...new Set(uses.map((use) => use.ref))];
  if (commits.length !== 1) {
    throw new Error(`${action} is pinned to ${commits.length} different commits: ${commits.join(', ')}`);
  }
  return commits[0];
}

/** Actions that are pinned to more than one commit across the given sources. */
export function divergentActionPins(
  sources: ReadonlyArray<readonly [string, string]>,
): Array<{ action: string; commits: string[] }> {
  const byAction = new Map<string, Set<string>>();
  for (const use of actionUses(sources)) {
    const commits = byAction.get(use.action) ?? new Set<string>();
    commits.add(use.ref);
    byAction.set(use.action, commits);
  }
  return [...byAction]
    .filter(([, commits]) => commits.size > 1)
    .map(([action, commits]) => ({ action, commits: [...commits].sort() }));
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * The version a package.json pins a dependency to.
 *
 * Throws unless the dependency is declared and its specifier is one exact
 * version: no range operator, tag, or protocol.
 */
export function exactNpmPin(manifest: PackageManifest, name: string): string {
  const specifier = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  if (specifier === undefined) {
    throw new Error(`${name} is not declared`);
  }
  if (!EXACT_VERSION.test(specifier)) {
    throw new Error(`${name} is declared as "${specifier}", not as one exact version`);
  }
  return specifier;
}

/**
 * The version requirement a Cargo.toml declares for a dependency, from either
 * `name = "1.2"` or `name = { version = "1.2", … }`.
 *
 * Throws unless the dependency is declared with a plain numeric requirement.
 */
export function cargoRequirement(cargoToml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `^${escaped}\\s*=\\s*(?:"([^"]+)"|\\{[^}\\n]*\\bversion\\s*=\\s*"([^"]+)"[^}\\n]*\\})`,
    'm',
  ).exec(cargoToml);
  if (!declaration) {
    throw new Error(`${name} is not declared with a version in Cargo.toml`);
  }
  const requirement = declaration[1] ?? declaration[2];
  if (!CARGO_REQUIREMENT.test(requirement)) {
    throw new Error(`${name} is declared as "${requirement}", not as a plain numeric requirement`);
  }
  return requirement;
}

/** Every version of a package that a Cargo.lock locks. */
export function lockedCargoVersions(cargoLock: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ...cargoLock.matchAll(new RegExp(`^name = "${escaped}"\\nversion = "([^"]+)"$`, 'gm')),
  ].map(([, version]) => version);
}

/**
 * Whether a locked version satisfies a plain Cargo requirement, which Cargo
 * reads as a caret requirement: at least the stated version, and unchanged in
 * its leftmost non-zero component (`0.10` allows 0.10.x, `2` allows 2.x.y,
 * `0.36.1` allows 0.36.1 and later 0.36.x).
 */
export function satisfiesCargoRequirement(version: string, requirement: string): boolean {
  const locked = version.split(/[-+]/)[0].split('.').map(Number);
  const stated = requirement.split('.').map(Number);
  const [major, minor = 0, patch = 0] = stated;
  const floor = [major, minor, patch];
  for (let index = 0; index < 3; index += 1) {
    if (locked[index] !== floor[index]) {
      if (locked[index] < floor[index]) return false;
      break;
    }
  }
  if (major > 0 || stated.length === 1) return locked[0] === major;
  if (minor > 0 || stated.length === 2) return locked[0] === 0 && locked[1] === minor;
  return locked[0] === 0 && locked[1] === 0 && locked[2] === patch;
}

/**
 * The locked version that satisfies a Cargo.toml dependency's requirement.
 *
 * Builds run with `--locked`, so this is the version that is actually
 * compiled. Throws unless the dependency is declared and exactly one locked
 * version starts with its requirement.
 */
export function lockedCargoPin(cargoToml: string, cargoLock: string, name: string): string {
  const requirement = cargoRequirement(cargoToml, name);
  const matching = lockedCargoVersions(cargoLock, name).filter((version) =>
    satisfiesCargoRequirement(version, requirement),
  );
  if (matching.length !== 1) {
    throw new Error(
      `${name} = "${requirement}" is satisfied by ${matching.length} locked versions; expected one`,
    );
  }
  return matching[0];
}

const DESKTOP_CRATE = 'native/desktop/psyche-build-tauri/src-tauri';

/** `lockedCargoPin` for the desktop crate's own Cargo.toml and Cargo.lock. */
export function desktopCargoPin(name: string): string {
  return lockedCargoPin(
    readFileSync(path.resolve(DESKTOP_CRATE, 'Cargo.toml'), 'utf8'),
    readFileSync(path.resolve(DESKTOP_CRATE, 'Cargo.lock'), 'utf8'),
    name,
  );
}

/**
 * The Rust release that rust-toolchain.toml pins.
 *
 * Throws unless the channel is one exact release, not `stable` or `1.95`.
 */
export function rustToolchainChannel(
  rustToolchainToml: string = readFileSync(path.resolve('rust-toolchain.toml'), 'utf8'),
): string {
  const channel = /^channel\s*=\s*"([^"]+)"$/m.exec(rustToolchainToml)?.[1];
  if (channel === undefined) {
    throw new Error('rust-toolchain.toml declares no channel');
  }
  if (!EXACT_VERSION.test(channel)) {
    throw new Error(`rust-toolchain.toml channel "${channel}" is not one exact release`);
  }
  return channel;
}

/** Escapes text for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
