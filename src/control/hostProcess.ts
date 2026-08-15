import { spawn, type ChildProcess } from 'node:child_process';
import { ControlClient, type ControlClientOptions } from './client.js';
__MERGED_IMPORTS_AND_TYPES_FROM_THEIRS_PLUS_CANONICALIZE__
export interface EnsureHostOptions {
  projectRoot: string;
  token: string;
  clientName: string;
  entryPath: string;
__OURS__
 */
export async function ensureHostControlPlane(
  options: EnsureHostOptions,
): Promise<ControlClient> {
__OURS__
