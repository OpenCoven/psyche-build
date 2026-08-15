__TAKE_OURS_VERBATIM__
    }
  }
}

function normalizePath(value: string): string {
  return process.platform === 'darwin' ? value.normalize('NFC') : value;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
