#!/usr/bin/env node

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argumentsList = process.argv.slice(2);
const debug = argumentsList.includes('--debug');
const outdirIndex = argumentsList.indexOf('--outdir');
const outdir = resolve(
  outdirIndex === -1 ? process.cwd() : argumentsList[outdirIndex + 1] ?? '',
);
const unknownArgument = argumentsList.find((argument, index) => (
  argument !== '--debug' && argument !== '--outdir' && !(outdirIndex !== -1 && index === outdirIndex + 1)
));
if (unknownArgument || (outdirIndex !== -1 && !argumentsList[outdirIndex + 1])) {
  throw new Error('usage: node scripts/build-web.mjs [--debug] [--outdir <directory>]');
}

const bundles = [
  ['web/control/control-entry.js', 'PsycheControl', 'web/control.bundle.js'],
  ['web/editor/editor-entry.js', 'PsycheCodeEditor', 'web/editor.bundle.js'],
  ['web/sessions/session-entry.js', 'PsycheSessions', 'web/sessions.bundle.js'],
  ['web/panes/pane-entry.js', 'PsychePanes', 'web/panes.bundle.js'],
  ['web/input/input-entry.js', 'PsycheTerminalInput', 'web/input.bundle.js'],
  ['web/diffs/diff-entry.js', 'PsycheDiffs', 'web/diffs.bundle.js'],
  ['web/status/status-entry.js', 'PsycheStatus', 'web/status.bundle.js'],
  ['web/workspace/workspace-entry.js', 'PsycheWorkspace', 'web/workspace.bundle.js'],
  ['web/runtime/runtime-entry.ts', 'PsycheRuntime', 'web/runtime.bundle.js'],
  [
    debug ? 'web/runtime/runtime-debug-entry.ts' : 'web/runtime/runtime-debug-stub.ts',
    'PsycheRuntimeDebug',
    'web/runtime-debug.bundle.js',
  ],
];

mkdirSync(outdir, { recursive: true });
await Promise.all(bundles.map(([entryPoint, globalName, outfile]) => build({
  entryPoints: [entryPoint],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName,
  outfile: resolve(outdir, outfile),
})));
