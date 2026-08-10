const IMAGE_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i;

export function isSupportedImagePath(path) {
  return typeof path === 'string' && IMAGE_EXTENSION_RE.test(path);
}

export function quotePosixPath(path) {
  return `'${String(path).replace(/'/g, `'\\''`)}'`;
}

export function buildImageDropInsertion(paths) {
  const accepted = [];
  const skipped = [];

  for (const path of Array.isArray(paths) ? paths : []) {
    if (isSupportedImagePath(path)) accepted.push(path);
    else skipped.push(path);
  }

  return {
    accepted,
    skipped,
    text: accepted.map(quotePosixPath).join(' '),
  };
}

export function physicalToCssPosition(position, scaleFactor) {
  const factor = Number(scaleFactor);
  const x = Number(position?.x);
  const y = Number(position?.y);

  if (
    !Number.isFinite(factor) ||
    factor <= 0 ||
    !Number.isFinite(x) ||
    x <= 0 ||
    !Number.isFinite(y) ||
    y <= 0
  ) {
    return null;
  }

  return { x: x / factor, y: y / factor };
}
