import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * Compares the `cfg` gate on a child module's `use super::` imports against
 * the gate on the declaration each one names.
 *
 * #366 imported `PinnedDirectory` unconditionally from a parent that declares
 * it `#[cfg(unix)]`. That is `error[E0432]` on Windows and compiles everywhere
 * else, so it survived a full local gate run on macOS and failed only on the
 * Windows leg of CI. The same shape recurred in #370, where two `#[cfg(test)]`
 * imports sat in the ungated group and `cargo check` stayed green because it
 * does not build `cfg(test)` code at all.
 *
 * Both were found by a compiler on a machine the author did not have. This
 * check finds them on any machine, before the push.
 */

const SRC_DIRECTORY = 'native/desktop/psyche-build-tauri/src-tauri/src';

export interface GateViolation {
  child: string;
  parent: string;
  item: string;
  importGate: string;
  declarationGate: string;
}

/** A `cfg` predicate: `all`/`any`/`not` over atoms such as `unix` or `test`. */
type Predicate =
  | { kind: 'atom'; name: string }
  | { kind: 'not'; inner: Predicate }
  | { kind: 'all' | 'any'; parts: Predicate[] };

const ALWAYS: Predicate = { kind: 'all', parts: [] };

/**
 * Every `use super::…` import whose gate does not imply its declaration's gate.
 *
 * Implication rather than equality: `#[cfg(all(unix, test))]` is a legitimate
 * import gate for a `#[cfg(unix)]` declaration, and rejecting it would push
 * authors to loosen the gate to silence the test — the opposite of the point.
 */
export function findGateViolations(): GateViolation[] {
  const root = resolve(process.cwd(), SRC_DIRECTORY);
  const violations: GateViolation[] = [];

  for (const { parentFile, childFile } of childModules(root)) {
    const parentSource = read(resolve(root, parentFile));
    const childSource = read(resolve(root, childFile));
    // A gated `mod` declaration gates everything the child imports.
    const moduleGate = declarationGate(parentSource, moduleName(childFile), 'mod');

    // Parent importing from child. The `use` lives in the parent, so the
    // child-to-parent scan below cannot see it, which is how #387 reached CI.
    for (const imported of moduleImports(parentSource, moduleName(childFile))) {
      const declared = declarationGate(childSource, imported.item);
      if (declared === undefined) continue;
      const effective: Predicate = { kind: 'all', parts: [moduleGate ?? ALWAYS, imported.gate] };
      if (!implies(effective, declared)) {
        violations.push({
          child: parentFile,
          parent: childFile,
          item: imported.item,
          importGate: render(effective),
          declarationGate: render(declared),
        });
      }
    }

    for (const imported of superImports(childSource)) {
      const target = imported.viaModule
        ? read(resolve(root, siblingPath(childFile, imported.viaModule)))
        : parentSource;
      const declared = declarationGate(target, imported.item);
      if (declared === undefined) continue; // not our call to resolve; the compiler reports it
      const effective: Predicate = { kind: 'all', parts: [moduleGate ?? ALWAYS, imported.gate] };
      if (!implies(effective, declared)) {
        violations.push({
          child: childFile,
          parent: imported.viaModule ? siblingPath(childFile, imported.viaModule) : parentFile,
          item: imported.item,
          importGate: render(effective),
          declarationGate: render(declared),
        });
      }
    }
  }
  return violations.sort((left, right) => (
    `${left.child}${left.item}`.localeCompare(`${right.child}${right.item}`)
  ));
}

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
}

/**
 * Directory part of a module path, or `''` for a crate-root sibling.
 *
 * `slice(0, lastIndexOf('/'))` returns `pty_reader.r` for `pty_reader.rs`,
 * because `lastIndexOf` is -1 and `slice(0, -1)` drops the final character.
 * Sibling resolution then looked for `pty_reader.r/pty_process.rs`. The bug
 * was unreachable until #197 slice 3 put a module beside `lib.rs` that
 * imports from another one.
 */
/** Path of a sibling module beside `file`, handling crate-root siblings. */
const siblingPath = (file: string, module: string): string => {
  const directory = dirOf(file);
  return directory === '' ? `${module}.rs` : `${directory}/${module}.rs`;
};

const dirOf = (file: string): string => {
  const cut = file.lastIndexOf('/');
  return cut === -1 ? '' : file.slice(0, cut);
};
const moduleName = (file: string): string => basename(file, '.rs');

/** Each `x/child.rs` sitting beside an `x.rs` that declares it. */
function childModules(root: string): { parentFile: string; childFile: string }[] {
  const pairs: { parentFile: string; childFile: string }[] = [];

  // Crate-root siblings. `lib.rs` declares `mod pty_process;` and the module
  // lives beside it, not under a directory, so the directory pairing below
  // never sees it. #387 imported four `#[cfg(unix)]` items from such a sibling
  // under `#[cfg(test)]` alone — green on macOS and Linux, E0432 on Windows —
  // and this contract stayed silent because its scope stopped at directories.
  const rootSource = read(resolve(root, 'lib.rs'));
  for (const match of rootSource.matchAll(/^(?:pub(?:\([a-z()]+\))? )?mod ([a-z_0-9]+);/gmu)) {
    const childFile = `${match[1]}.rs`;
    if (existsSync(resolve(root, childFile))) pairs.push({ parentFile: 'lib.rs', childFile });
  }
  // Sorted: `readdirSync` order varies by filesystem, and an unstable report
  // order makes a multi-violation failure hard to diff between runs.
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const directory of directories) {
    const parentFile = `${directory}.rs`;
    if (!existsSync(resolve(root, parentFile))) continue;
    for (const child of readdirSync(resolve(root, directory)).sort()) {
      if (child.endsWith('.rs')) pairs.push({ parentFile, childFile: `${directory}/${child}` });
    }
  }
  return pairs;
}

/**
 * Source with comments and string literals blanked, preserving offsets.
 *
 * A commented-out import keeps its original indentation, so a block-commented
 * `use super::Foo;` still begins a line and is matched by a scan over raw
 * text. It would then be reported against a declaration that may not exist,
 * failing the contract over code the compiler never sees.
 *
 * Line comments that merely mention an import in prose are already excluded by
 * the line anchor in `superImports`; this handles the commented-out-code case
 * that anchor cannot see.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/gu, ' ');
      index = stop;
    } else if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        cursor += source[cursor] === '\\' ? 2 : 1;
      }
      out += ' '.repeat(Math.min(cursor + 1, source.length) - index);
      index = cursor + 1;
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

interface SuperImport { item: string; gate: Predicate; viaModule?: string }

/**
 * `use <module>::…` in a parent, for a module it declares.
 *
 * Visibility is optional because a re-export is an import too:
 * `native_workspace.rs` carries `pub(crate) use workspace_paths::workspace_default_path;`
 * so `lib.rs` can keep calling it by its old path. A `pub use` is in fact the
 * more dangerous form — it binds the child's item *and* republishes it — so
 * missing it would leave the widest parent-to-child coupling unchecked.
 */
function moduleImports(source: string, module: string): SuperImport[] {
  const clean = stripCommentsAndStrings(source);
  const imports: SuperImport[] = [];
  const pattern = new RegExp(
    `^[ \\t]*(?:pub(?:\\([a-z():]+\\))? )?use[ \\t]+${module}::([^;]*);`,
    'gmu',
  );
  for (const match of clean.matchAll(pattern)) {
    const gate = gateBefore(clean, match.index ?? 0, source);
    const tail = match[1].trim();
    const names = tail.startsWith('{') ? tail.slice(1, tail.lastIndexOf('}')).split(',') : [tail];
    for (const raw of names) {
      const item = raw.trim().split(/\s+as\s+/u)[0].trim();
      if (item && item !== 'self' && item !== '*') imports.push({ item, gate });
    }
  }
  return imports;
}

/** `use super::X;`, `use super::{A, B};`, `use super::sibling::{A};` — braces may span lines. */
function superImports(source: string): SuperImport[] {
  const clean = stripCommentsAndStrings(source);
  const imports: SuperImport[] = [];
  const pattern = /^[ \t]*use[ \t]+super::([^;]*);/gmu;
  for (const match of clean.matchAll(pattern)) {
    const gate = gateBefore(clean, match.index ?? 0, source);
    let tail = match[1].trim();
    let viaModule: string | undefined;
    // `super::sibling::…` names a sibling module; `super::Item` names the parent's.
    const viaSibling = /^([a-z_0-9]+)::(.*)$/su.exec(tail);
    if (viaSibling && !tail.startsWith('{')) {
      viaModule = viaSibling[1];
      tail = viaSibling[2].trim();
    }
    const names = tail.startsWith('{')
      ? tail.slice(1, tail.lastIndexOf('}')).split(',')
      : [tail];
    for (const raw of names) {
      const item = raw.trim().split(/\s+as\s+/u)[0].trim();
      if (item && item !== 'self' && item !== '*') imports.push({ item, gate, viaModule });
    }
  }
  return imports;
}

/**
 * The gate on the declaration of `item`, or undefined when it is not declared here.
 *
 * Two placements the obvious scan misses, both real in this tree:
 * `RestoreCandidateFileOperation` carries `#[cfg(test)]` above a `#[derive(…)]`,
 * so only the line above the declaration is not enough; and the fault-injection
 * thread-locals are gated on the enclosing `thread_local!` block rather than on
 * the statics themselves.
 */
function declarationGate(source: string, item: string, kind?: string): Predicate | undefined {
  const clean = stripCommentsAndStrings(source);
  const lines = clean.split('\n');
  // Declarations are matched on stripped text so a commented-out one does not
  // count, but gates are read from the raw text: stripping blanks string
  // literals, and a `cfg` value *is* one. `#[cfg(target_os = "windows")]`
  // would otherwise parse as the atom `target_os = ` with the value gone,
  // silently comparing two different conditions as though they were equal.
  const raw = source.split('\n');
  const kinds = kind ?? 'fn|struct|enum|type|const|static|trait|mod|union';
  const declaration = new RegExp(`^(?:pub(?:\\([a-z():]+\\))? )?(?:unsafe )?(?:async )?(?:${kinds}) ${item}\\b`, 'u');
  const nested = new RegExp(`^\\s+(?:pub(?:\\([a-z():]+\\))? )?static ${item}\\s*:`, 'u');

  // Every declaration, not the first. A `cfg`-gated pair declares one item per
  // platform — `coven_launch_session` is `#[cfg(unix)]` and
  // `#[cfg(target_os = "windows")]` — and the item exists wherever *either*
  // applies. Reading only the first reports an ungated import of a fully
  // covered pair as a violation, which is how correct code looks broken.
  const gates: Predicate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (declaration.test(lines[index])) gates.push(attributeGate(raw, index));
    else if (nested.test(lines[index])) {
      let gate = attributeGate(raw, index);
      // Inherit the gate of the enclosing macro block.
      for (let scan = index; scan >= 0; scan -= 1) {
        if (/^[a-z_]+!\s*\{/u.test(lines[scan])) {
          gate = attributeGate(raw, scan);
          break;
        }
      }
      gates.push(gate);
    }
  }
  if (gates.length === 0) return undefined;
  return gates.length === 1 ? gates[0] : { kind: 'any', parts: gates };
}

/** Conjunction of every `#[cfg(…)]` in the attribute run above `line`. */
function attributeGate(lines: string[], line: number): Predicate {
  const parts: Predicate[] = [];
  let index = line;
  while (index > 0) {
    const previous = lines[index - 1].trim();
    if (!previous.startsWith('#[') && previous !== '') break;
    if (previous === '') break;
    const cfg = /^#\[cfg\((.*)\)\]$/su.exec(previous);
    if (cfg) parts.push(parse(cfg[1]));
    index -= 1;
  }
  return parts.length === 1 ? parts[0] : { kind: 'all', parts };
}

function gateBefore(source: string, offset: number, raw?: string): Predicate {
  // The final element is the text on the `use` line itself, so the attribute
  // run ends at the line before it. Gates come from the raw text when it is
  // available, so `cfg` string values survive comment stripping.
  const before = source.slice(0, offset).split('\n');
  const lines = raw === undefined ? before : raw.split('\n').slice(0, before.length);
  return attributeGate(lines, before.length - 1);
}

function parse(text: string): Predicate {
  const trimmed = text.trim();
  const combinator = /^(all|any|not)\s*\((.*)\)$/su.exec(trimmed);
  if (combinator) {
    const parts = splitTop(combinator[2]).map(parse);
    if (combinator[1] === 'not') return { kind: 'not', inner: parts[0] };
    return { kind: combinator[1] as 'all' | 'any', parts };
  }
  return { kind: 'atom', name: canonicalAtom(trimmed) };
}

/**
 * Built-in `cfg` spellings that name the same condition, folded to one atom.
 *
 * `implies` treats atoms as independent booleans, so `windows` and
 * `target_os = "windows"` would otherwise compare as unrelated and a
 * declaration using one spelling with an import using the other would be
 * reported as a violation. This crate already mixes both: `lib.rs` writes
 * `#[cfg(windows)]` and `browser_focus.rs` writes `#[cfg(target_os =
 * "windows")]`.
 *
 * Only exact aliases are folded. `windows` is not recorded as the negation of
 * `unix`, because a target can be neither. Atoms outside this table stay
 * independent, which can over-report rather than under-report — a spurious
 * failure is a prompt to look, whereas a missed one is the defect this
 * contract exists to catch.
 */
function canonicalAtom(atom: string): string {
  const normalized = atom.replace(/\s*=\s*/gu, ' = ');
  const aliases = new Map([
    ['target_family = "unix"', 'unix'],
    ['target_family = "windows"', 'windows'],
    ['target_os = "windows"', 'windows'],
  ]);
  return aliases.get(normalized) ?? normalized;
}

/** Split on commas that are not inside parentheses. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function atoms(predicate: Predicate, into: Set<string> = new Set()): Set<string> {
  if (predicate.kind === 'atom') into.add(predicate.name);
  else if (predicate.kind === 'not') atoms(predicate.inner, into);
  else predicate.parts.forEach((part) => atoms(part, into));
  return into;
}

function evaluate(predicate: Predicate, world: Map<string, boolean>): boolean {
  switch (predicate.kind) {
    case 'atom': return world.get(predicate.name) ?? false;
    case 'not': return !evaluate(predicate.inner, world);
    case 'all': return predicate.parts.every((part) => evaluate(part, world));
    case 'any': return predicate.parts.some((part) => evaluate(part, world));
  }
}

/**
 * True when every configuration that enables `left` also enables `right`.
 *
 * Decided by enumerating the handful of atoms involved rather than by
 * comparing predicates syntactically, so a narrower-but-differently-written
 * gate passes instead of forcing an author to match the parent's spelling.
 */
function implies(left: Predicate, right: Predicate): boolean {
  const names = [...atoms(left, atoms(right))];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const world = new Map(names.map((name, bit) => [name, Boolean(mask & (1 << bit))]));
    if (!plausibleTarget(world)) continue;
    if (evaluate(left, world) && !evaluate(right, world)) return false;
  }
  return true;
}

/**
 * Whether a world describes a target this crate can actually be built for.
 *
 * Exactly one of `unix` and `windows` holds for every platform in
 * `Cargo.toml` — macOS, Linux, iOS and Windows — so worlds where both or
 * neither hold are not configurations anything here compiles under.
 *
 * This reverses a decision made when the contract was written. #371 recorded
 * that `windows` is deliberately not the negation of `unix`, "because a target
 * can be neither". That is true of Rust in general and false of this crate,
 * and enforcing the general rule made the contract report correct code as
 * broken: `coven_launch_session` is declared once per family, so an ungated
 * import of it is right, and without this the check called four such imports
 * violations. A contract that flags correct code gets ignored, which costs
 * more than the narrow generality it was protecting.
 */
function plausibleTarget(world: Map<string, boolean>): boolean {
  const unix = world.get('unix');
  const windows = world.get('windows');
  if (unix === undefined || windows === undefined) return true;
  return unix !== windows;
}

function render(predicate: Predicate): string {
  switch (predicate.kind) {
    case 'atom': return predicate.name;
    case 'not': return `not(${render(predicate.inner)})`;
    case 'all': return predicate.parts.length === 0
      ? '(ungated)'
      : predicate.parts.filter((p) => !(p.kind === 'all' && p.parts.length === 0))
        .map(render).join(' + ') || '(ungated)';
    case 'any': return `any(${predicate.parts.map(render).join(', ')})`;
  }
}

/** Child modules the scan covers, so a parser that matches nothing cannot pass silently. */
export function scannedModules(): string[] {
  const root = resolve(process.cwd(), SRC_DIRECTORY);
  return childModules(root).map((pair) => pair.childFile);
}

/**
 * The gate this scan resolves for `item` as imported by `child`, rendered.
 *
 * Exposed so the contract can prove the awkward placements are actually being
 * read, rather than silently skipped by `declarationGate` returning undefined.
 */
export function resolvedGate(child: string, item: string): string | undefined {
  const root = resolve(process.cwd(), SRC_DIRECTORY);
  const pair = childModules(root).find((candidate) => candidate.childFile === child);
  if (pair === undefined) return undefined;
  const gate = declarationGate(read(resolve(root, pair.parentFile)), item);
  return gate === undefined ? undefined : render(gate);
}

/** Names a child module imports from its parent, for contract assertions. */
export function parentImports(child: string): string[] {
  const root = resolve(process.cwd(), SRC_DIRECTORY);
  const pair = childModules(root).find((candidate) => candidate.childFile === child);
  if (pair === undefined) return [];
  return superImports(read(resolve(root, pair.childFile)))
    .filter((imported) => imported.viaModule === undefined)
    .map((imported) => imported.item);
}

/**
 * Whether an import written under `importGate` may name a declaration written
 * under `declarationGate`. Both are `cfg` predicate bodies, or `undefined` for
 * an ungated item.
 *
 * Exposed so the implication rules can be asserted directly, rather than only
 * through whichever combinations the tree happens to contain today.
 */
export function importGateSatisfies(
  importGate: string | undefined,
  declarationGate: string | undefined,
): boolean {
  return implies(
    importGate === undefined ? ALWAYS : parse(importGate),
    declarationGate === undefined ? ALWAYS : parse(declarationGate),
  );
}

/** Names a parent imports from one of its child modules. Exported for contract self-checks. */
export function parentImportsOf(parentFile: string, module: string): string[] {
  const root = resolve(process.cwd(), SRC_DIRECTORY);
  return moduleImports(read(resolve(root, parentFile)), module).map((imported) => imported.item);
}
