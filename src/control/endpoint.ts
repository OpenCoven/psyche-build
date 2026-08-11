import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The canonical control endpoint for a project.
 *
 * Every owner binds one control socket derived purely from its canonical
 * project root, so a client that knows the root can always find the owner
 * without a discovery port. The hash keeps the filesystem path short and
 * opaque while staying deterministic across processes.
 */
export function controlEndpointForProject(canonicalProjectRoot: string): string {
  const id = createHash('sha256').update(canonicalProjectRoot).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\psyche-control-${id}`
    : path.join(homedir(), '.psyche', 'runtime', 'sockets', `${id}.sock`);
}

/** The directory that must exist (mode 0700) before binding a socket endpoint. */
export function controlEndpointParent(endpoint: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  return path.dirname(endpoint);
}
