#!/usr/bin/env node

import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const children = new Set();
let shuttingDown = false;

function spawnChild(label, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  });

  children.add(child);

  child.on('error', (error) => {
    console.error(`[dev:watch] ${label} failed to start: ${error.message}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    children.delete(child);

    if (shuttingDown) {
      return;
    }

    if (signal) {
      console.error(`[dev:watch] ${label} exited from ${signal}`);
      shutdown(1);
      return;
    }

    if (code === 0) {
      console.log(`[dev:watch] ${label} exited cleanly`);
    } else {
      console.error(`[dev:watch] ${label} exited with code ${code}`);
    }

    shutdown(code || 0);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

spawnChild('TypeScript watcher', 'pnpm', ['exec', 'tsc', '--watch', '--preserveWatchOutput']);
spawnChild('psyche runtime', process.execPath, ['--watch', 'dist/index.js'], {
  env: {
    ...process.env,
    PSYCHE_DEV: 'true',
    PSYCHE_DEV_WATCH: 'true',
  },
});
