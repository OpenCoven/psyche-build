#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

  child.on('exit', (code, signal) => {
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
