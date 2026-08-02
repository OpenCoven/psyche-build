import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RemotePaneActionShortcut } from './remotePaneActions.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveComuxExecutable(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const localComuxPath = path.resolve(currentDir, '..', '..', 'comux');

  if (fs.existsSync(localComuxPath)) {
    return localComuxPath;
  }

  return 'comux';
}

export function buildFilesOnlyCommand(): string {
  return `${shellQuote(resolveComuxExecutable())} --files-only`;
}

export function buildRemotePaneActionCommand(
  shortcut: RemotePaneActionShortcut
): string {
  return `${shellQuote(resolveComuxExecutable())} --remote-pane-action ${shortcut}`;
}
