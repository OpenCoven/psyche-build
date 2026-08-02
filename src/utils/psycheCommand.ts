import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RemotePaneActionShortcut } from './remotePaneActions.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolvePsycheExecutable(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const localPsychePath = path.resolve(currentDir, '..', '..', 'psyche');

  if (fs.existsSync(localPsychePath)) {
    return localPsychePath;
  }

  return 'psyche';
}

export function buildFilesOnlyCommand(): string {
  return `${shellQuote(resolvePsycheExecutable())} --files-only`;
}

export function buildRemotePaneActionCommand(
  shortcut: RemotePaneActionShortcut
): string {
  return `${shellQuote(resolvePsycheExecutable())} --remote-pane-action ${shortcut}`;
}
