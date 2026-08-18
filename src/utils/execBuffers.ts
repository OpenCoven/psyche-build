/**
 * Ceilings for synchronous child-process output.
 *
 * Node defaults execSync's maxBuffer to 1MB and kills the child when output
 * passes it. Commands here routinely produce more than that — a pane's full
 * scrollback with escape sequences, or `git status` in a repository with a
 * large untracked tree — and the resulting ENOBUFS is easy to mistake for an
 * empty result. Every call site that can produce bulk output should set one of
 * these explicitly and decide what an overflow means, rather than inheriting a
 * limit nobody chose.
 */

/** Bulk text output: pane captures, porcelain listings. */
export const EXEC_BULK_MAX_BYTES = 32 * 1024 * 1024;

/** Error code execAsync tags its own overflow rejection with. */
export const EXEC_MAX_BYTES_CODE = 'EXEC_MAX_BYTES';

/**
 * True when a child process was killed for producing too much output.
 *
 * Covers all three shapes this arrives in: execSync's ENOBUFS, the maxBuffer
 * message Node uses on platforms that omit the code, and execAsync's own
 * tagged rejection.
 */
export function isExecBufferOverflow(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 'ENOBUFS' || candidate.code === EXEC_MAX_BYTES_CODE) return true;
  return typeof candidate.message === 'string' && candidate.message.includes('maxBuffer');
}
