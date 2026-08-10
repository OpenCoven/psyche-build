const IMAGE_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i;
const ASCII_C1_CONTROL_RE = /[\x00-\x1F\x7F-\x9F]/;

export function isSupportedImagePath(path) {
  return (
    typeof path === 'string' &&
    !ASCII_C1_CONTROL_RE.test(path) &&
    IMAGE_EXTENSION_RE.test(path)
  );
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
    !Number.isFinite(y)
  ) {
    return null;
  }

  return { x: x / factor, y: y / factor };
}
