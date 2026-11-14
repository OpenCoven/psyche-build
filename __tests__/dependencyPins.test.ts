import { describe, expect, it } from 'vitest';
import {
  actionUses,
  cargoRequirement,
  divergentActionPins,
  exactNpmPin,
  lockedCargoPin,
  pinnedActionCommit,
  rustToolchainChannel,
  satisfiesCargoRequirement,
} from './support/dependencyPins.js';

// The contract tests no longer repeat pinned values, so these cases are what
// keeps "read the pin from its source" from meaning "accept whatever is there".
// Each one is a pin the repository must refuse.

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

function workflow(...uses: string[]): Array<[string, string]> {
  return [['ci.yml', `jobs:\n  build:\n    steps:\n${uses.map((use) => `      - uses: ${use}\n`).join('')}`]];
}

describe('action pins', () => {
  it('returns the commit of an action pinned to a full SHA with a version comment', () => {
    const sources = workflow(`actions/checkout@${COMMIT_A} # v4.3.1`);

    expect(pinnedActionCommit(sources, 'actions/checkout')).toBe(COMMIT_A);
    expect(actionUses(sources)).toEqual([
      { file: 'ci.yml', action: 'actions/checkout', ref: COMMIT_A, comment: 'v4.3.1' },
    ]);
  });

  it('reads a `uses:` that carries its own step name', () => {
    const sources: Array<[string, string]> = [
      ['ci.yml', `    steps:\n      - name: Check out\n        uses: actions/checkout@${COMMIT_A} # v4.3.1\n`],
    ];

    expect(pinnedActionCommit(sources, 'actions/checkout')).toBe(COMMIT_A);
  });

  it.each([
    ['a tag', 'actions/checkout@v4 # v4'],
    ['a branch', 'actions/checkout@main # main'],
    ['a short SHA', 'actions/checkout@34e1148 # v4.3.1'],
    ['an upper-case SHA', `actions/checkout@${'A'.repeat(40)} # v4.3.1`],
  ])('refuses an action pinned to %s', (_, use) => {
    expect(() => pinnedActionCommit(workflow(use), 'actions/checkout')).toThrow(
      /not pinned to a full commit SHA/,
    );
  });

  it('refuses a commit pin with no version comment', () => {
    expect(() =>
      pinnedActionCommit(workflow(`actions/checkout@${COMMIT_A}`), 'actions/checkout'),
    ).toThrow(/no trailing version comment/);
  });

  it('refuses an action that is not used at all', () => {
    expect(() =>
      pinnedActionCommit(workflow(`actions/checkout@${COMMIT_A} # v4.3.1`), 'actions/setup-node'),
    ).toThrow(/not used/);
  });

  it('refuses one action pinned to two commits, in one file or across files', () => {
    const oneFile = workflow(
      `actions/checkout@${COMMIT_A} # v4.3.1`,
      `actions/checkout@${COMMIT_B} # v7.0.1`,
    );
    const twoFiles: Array<[string, string]> = [
      ...workflow(`actions/checkout@${COMMIT_A} # v4.3.1`),
      ['release.yml', `      - uses: actions/checkout@${COMMIT_B} # v7.0.1\n`],
    ];

    expect(() => pinnedActionCommit(oneFile, 'actions/checkout')).toThrow(/2 different commits/);
    expect(divergentActionPins(twoFiles)).toEqual([
      { action: 'actions/checkout', commits: [COMMIT_A, COMMIT_B] },
    ]);
    expect(divergentActionPins(workflow(`actions/checkout@${COMMIT_A} # v4.3.1`))).toEqual([]);
  });

  it('leaves local composite actions out', () => {
    expect(actionUses(workflow('./.github/actions/setup-xcodegen'))).toEqual([]);
  });
});

describe('npm pins', () => {
  it('returns an exact version from either dependency table', () => {
    expect(exactNpmPin({ dependencies: { vite: '8.2.1' } }, 'vite')).toBe('8.2.1');
    expect(exactNpmPin({ devDependencies: { vite: '8.2.1' } }, 'vite')).toBe('8.2.1');
  });

  it.each(['^8.2.1', '~8.2.1', '>=8', '8.2', '8', 'latest', '*', 'workspace:*', 'npm:rolldown-vite@8.2.1', '8.2.1-beta.1'])(
    'refuses the specifier %s',
    (specifier) => {
      expect(() => exactNpmPin({ devDependencies: { vite: specifier } }, 'vite')).toThrow(
        /not as one exact version/,
      );
    },
  );

  it('refuses a dependency that is not declared', () => {
    expect(() => exactNpmPin({ dependencies: {} }, 'vite')).toThrow(/not declared/);
  });
});

describe('Cargo pins', () => {
  const lock = [
    '[[package]]\nname = "getrandom"\nversion = "0.2.17"\n',
    '[[package]]\nname = "getrandom"\nversion = "0.3.4"\n',
    '[[package]]\nname = "sha2"\nversion = "0.10.9"\n',
    '[[package]]\nname = "sha2-asm"\nversion = "0.6.4"\n',
  ].join('\n');

  it('reads a requirement from the short and the table form', () => {
    expect(cargoRequirement('sha2 = "0.10"\n', 'sha2')).toBe('0.10');
    expect(
      cargoRequirement('ed25519-dalek = { version = "2.2", default-features = false }\n', 'ed25519-dalek'),
    ).toBe('2.2');
  });

  it.each([
    ['a missing dependency', 'base64 = "0.22"\n'],
    ['a name that only shares a prefix', 'sha2-asm = "0.6"\n'],
    ['a git dependency', 'sha2 = { git = "https://example.invalid/sha2" }\n'],
    ['a path dependency', 'sha2 = { path = "vendor/sha2" }\n'],
  ])('refuses %s', (_, cargoToml) => {
    expect(() => cargoRequirement(cargoToml, 'sha2')).toThrow(/not declared with a version/);
  });

  it.each(['*', '>=0.10', '0.10.*', '=0.10.9', '~0.10'])('refuses the requirement %s', (requirement) => {
    expect(() => cargoRequirement(`sha2 = "${requirement}"\n`, 'sha2')).toThrow(
      /not as a plain numeric requirement/,
    );
  });

  it('returns the one locked version the requirement allows', () => {
    expect(lockedCargoPin('getrandom = "0.2"\n', lock, 'getrandom')).toBe('0.2.17');
    expect(lockedCargoPin('sha2 = "0.10"\n', lock, 'sha2')).toBe('0.10.9');
  });

  it('refuses a requirement that no locked version satisfies', () => {
    expect(() => lockedCargoPin('getrandom = "0.4"\n', lock, 'getrandom')).toThrow(
      /satisfied by 0 locked versions/,
    );
    expect(() => lockedCargoPin('sha2 = "0.10"\n', '', 'sha2')).toThrow(/satisfied by 0 locked versions/);
  });

  it('reads plain requirements as Cargo does', () => {
    expect(satisfiesCargoRequirement('0.36.1', '0.36.1')).toBe(true);
    expect(satisfiesCargoRequirement('0.36.4', '0.36.1')).toBe(true);
    expect(satisfiesCargoRequirement('0.36.0', '0.36.1')).toBe(false);
    expect(satisfiesCargoRequirement('0.37.0', '0.36.1')).toBe(false);
    expect(satisfiesCargoRequirement('0.10.9', '0.10')).toBe(true);
    expect(satisfiesCargoRequirement('0.11.0', '0.10')).toBe(false);
    expect(satisfiesCargoRequirement('2.9.3', '2')).toBe(true);
    expect(satisfiesCargoRequirement('2.9.3', '2.2')).toBe(true);
    expect(satisfiesCargoRequirement('2.1.0', '2.2')).toBe(false);
    expect(satisfiesCargoRequirement('3.0.0', '2')).toBe(false);
    expect(satisfiesCargoRequirement('0.0.4', '0.0.3')).toBe(false);
    expect(satisfiesCargoRequirement('0.0.3', '0.0.3')).toBe(true);
  });
});

describe('Rust toolchain pin', () => {
  it('returns one exact release', () => {
    expect(rustToolchainChannel('[toolchain]\nchannel = "1.95.0"\n')).toBe('1.95.0');
  });

  it.each(['stable', 'nightly', '1.95', 'nightly-2026-03-27'])('refuses the channel %s', (channel) => {
    expect(() => rustToolchainChannel(`[toolchain]\nchannel = "${channel}"\n`)).toThrow(
      /not one exact release/,
    );
  });

  it('refuses a toolchain file with no channel', () => {
    expect(() => rustToolchainChannel('[toolchain]\ncomponents = ["rustfmt"]\n')).toThrow(
      /declares no channel/,
    );
  });

  it('reads the repository toolchain file by default', () => {
    expect(rustToolchainChannel()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
