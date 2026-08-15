import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import {
  loadBrowserSnapshot,
  loadDiffPreview,
  isDependencyBrowserPath,
  MAX_PREVIEW_BYTES,
  type BrowserSnapshot,
} from '../../utils/fileBrowser.js';

export type MobileInspectionErrorCode = 'invalid_path' | 'path_outside_root';

export class MobileInspectionError extends Error {
  constructor(
    readonly code: MobileInspectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MobileInspectionError';
  }
}

export interface MobileFilePreview {
  text: string;
  truncated: boolean;
}

export interface MobileInspection {
  list(root: string): Promise<BrowserSnapshot>;
  readFile(input: { root: string; relativePath: string }): Promise<MobileFilePreview>;
  diff(root: string, relativePath: string, statusCode: string): Promise<string>;
}

interface ResolvedInspectionPath {
  canonicalRoot: string;
  canonicalTarget: string;
  repositoryPath: string;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function resolveWithExistingAncestor(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let current = candidate;

  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function resolveInside(root: string, relativePath: string): Promise<ResolvedInspectionPath> {
  if (!relativePath || relativePath.includes('\0')) {
    throw new MobileInspectionError('invalid_path', 'file path must be a non-empty relative path');
  }

  const canonicalRoot = await realpath(root);
  if (path.isAbsolute(relativePath)) {
    throw new MobileInspectionError('path_outside_root', 'file path is outside the selected worktree');
  }

  const lexicalTarget = path.resolve(canonicalRoot, relativePath);
  if (!isContained(canonicalRoot, lexicalTarget) || lexicalTarget === canonicalRoot) {
    throw new MobileInspectionError('path_outside_root', 'file path is outside the selected worktree');
  }

  const canonicalTarget = await resolveWithExistingAncestor(lexicalTarget);
  if (!isContained(canonicalRoot, canonicalTarget) || canonicalTarget === canonicalRoot) {
    throw new MobileInspectionError('path_outside_root', 'file path is outside the selected worktree');
  }

  return {
    canonicalRoot,
    canonicalTarget,
    repositoryPath: path.relative(canonicalRoot, lexicalTarget).split(path.sep).join('/'),
  };
}

export function createMobileInspection(
  options: { maxPreviewBytes?: number } = {},
): MobileInspection {
  const maxPreviewBytes = options.maxPreviewBytes ?? MAX_PREVIEW_BYTES;
  if (!Number.isSafeInteger(maxPreviewBytes) || maxPreviewBytes < 1) {
    throw new RangeError('maxPreviewBytes must be a positive safe integer');
  }

  return {
    async list(root: string): Promise<BrowserSnapshot> {
      const canonicalRoot = await realpath(root);
      const snapshot = loadBrowserSnapshot(canonicalRoot);
      return {
        ...snapshot,
        files: snapshot.files.filter((file) => !isDependencyBrowserPath(file.path)),
      };
    },

    async readFile({ root, relativePath }): Promise<MobileFilePreview> {
      const { canonicalTarget } = await resolveInside(root, relativePath);
      const handle = await open(canonicalTarget, 'r');

      try {
        const stats = await handle.stat();
        const buffer = Buffer.alloc(Math.min(stats.size, maxPreviewBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          text: buffer.subarray(0, bytesRead).toString('utf8'),
          truncated: stats.size > maxPreviewBytes,
        };
      } finally {
        await handle.close();
      }
    },

    async diff(root: string, relativePath: string, statusCode: string): Promise<string> {
      const { canonicalRoot, repositoryPath } = await resolveInside(root, relativePath);
      return stripAnsi(
        loadDiffPreview(canonicalRoot, repositoryPath, statusCode, 'never').join('\n'),
      );
    },
  };
}
