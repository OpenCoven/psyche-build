const languageByExtension = new Map([
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['json', 'json'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xml', 'xml'],
  ['css', 'css'],
  ['md', 'markdown'],
  ['mdx', 'markdown'],
  ['markdown', 'markdown'],
  ['py', 'python'],
  ['rs', 'rust'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
]);

export function languageForPath(path) {
  const name = path.split('/').pop();
  if (name === 'Dockerfile' || name === 'Makefile') {
    return 'shell';
  }

  const extension = name?.split('.').pop()?.toLowerCase();
  return languageByExtension.get(extension) ?? 'plain';
}

export function createFileBuffer(text) {
  return { text, originalText: text, dirty: false };
}

export function updateFileBuffer(buffer, text) {
  return { ...buffer, text, dirty: text !== buffer.originalText };
}

export function markFileSaved(buffer, text) {
  return { ...buffer, text, originalText: text, dirty: false };
}

export function reconcileFileSave(buffer, savedText, currentText) {
  const rebased = updateFileBuffer(
    markFileSaved(buffer, savedText),
    currentText,
  );
  return { buffer: rebased, canContinue: !rebased.dirty };
}

export function shouldRenderFileSaveChrome(activeFileId, savedFileId) {
  return activeFileId === savedFileId;
}

export function workspaceFiles(openFiles, projectId, workspaceRoot) {
  return (Array.isArray(openFiles) ? openFiles : []).filter((file) =>
    file.projectId === projectId && file.workspaceRoot === workspaceRoot
  );
}

export function nextFileIdAfterClose(files, closingId) {
  const ordered = Array.isArray(files) ? files : [];
  const index = ordered.findIndex((file) => file.id === closingId);
  if (index === -1) return ordered[0]?.id ?? null;
  const remaining = ordered.filter((file) => file.id !== closingId);
  return remaining[Math.min(index, remaining.length - 1)]?.id ?? null;
}

export function createRequestGate() {
  let current = 0;

  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
  };
}

export function createLruCache(limit) {
  const entries = new Map();

  return {
    get(key) {
      if (!entries.has(key)) {
        return undefined;
      }

      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);

      while (entries.size > limit) {
        entries.delete(entries.keys().next().value);
      }
    },
    deleteWhere(predicate) {
      for (const key of entries.keys()) {
        if (predicate(key)) {
          entries.delete(key);
        }
      }
    },
    clear() {
      entries.clear();
    },
  };
}
