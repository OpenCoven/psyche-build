#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_LAUNCH_ERROR_CHARS = 512;

function boundedLaunchErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= MAX_LAUNCH_ERROR_CHARS) return message;
  return `${message.slice(0, MAX_LAUNCH_ERROR_CHARS - 1)}…`;
}

export function launchDiagnostics(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const processApi = options.processApi || process;
  const platform = options.platform || processApi.platform;
  const env = options.env || processApi.env;
  const child = spawnImpl('pnpm', ['dev:tauri'], {
    env: { ...env, PSYCHE_RENDER_DIAGNOSTICS: '1' },
    shell: platform === 'win32',
    stdio: 'inherit',
  });

  let settled = false;
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    processApi.stderr?.write(
      `failed to start Tauri diagnostics: ${boundedLaunchErrorMessage(error)}\n`,
    );
    processApi.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    if (signal) {
      processApi.kill(processApi.pid, signal);
    } else {
      processApi.exitCode = code ?? 1;
    }
  });

  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchDiagnostics();
}
