export const PROJECT_ACCENTS = Object.freeze([
  Object.freeze({ id: 'ruby', label: 'Ruby', rgb: '239 86 100' }),
  Object.freeze({ id: 'amber', label: 'Amber', rgb: '232 166 67' }),
  Object.freeze({ id: 'lime', label: 'Lime', rgb: '137 201 92' }),
  Object.freeze({ id: 'teal', label: 'Teal', rgb: '64 190 159' }),
  Object.freeze({ id: 'cyan', label: 'Cyan', rgb: '65 185 218' }),
  Object.freeze({ id: 'blue', label: 'Blue', rgb: '86 139 235' }),
  Object.freeze({ id: 'violet', label: 'Violet', rgb: '145 111 235' }),
  Object.freeze({ id: 'magenta', label: 'Magenta', rgb: '215 91 180' }),
]);

export const PROJECT_GLYPHS = Object.freeze([
  Object.freeze({ id: 'spark', label: 'Spark', value: '✦' }),
  Object.freeze({ id: 'diamond', label: 'Diamond', value: '◆' }),
  Object.freeze({ id: 'command', label: 'Command', value: '⌘' }),
  Object.freeze({ id: 'branch', label: 'Branch', value: '⑂' }),
  Object.freeze({ id: 'terminal', label: 'Terminal', value: '>_' }),
  Object.freeze({ id: 'moon', label: 'Moon', value: '☾' }),
  Object.freeze({ id: 'bolt', label: 'Bolt', value: 'ϟ' }),
  Object.freeze({ id: 'circle', label: 'Circle', value: '◉' }),
]);

const accentsById = new Map(PROJECT_ACCENTS.map((accent) => [accent.id, accent]));
const glyphsById = new Map(PROJECT_GLYPHS.map((glyph) => [glyph.id, glyph]));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function normalizeProjectAppearanceKey(root, fallback = '') {
  let value = typeof root === 'string' && root.trim()
    ? root
    : String(fallback || '').trim();
  if (!value) return '';

  value = value.replaceAll('\\', '/');
  if (/^[A-Z]:\//.test(value)) {
    value = value[0].toLowerCase() + value.slice(1);
  }
  if (value !== '/' && !/^[a-z]:\/$/i.test(value)) {
    value = value.replace(/\/+$/, '');
  }
  return value;
}

export function stableProjectAppearanceHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sanitizeProjectAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const sanitized = {};
  if (typeof value.accent === 'string' && accentsById.has(value.accent)) {
    sanitized.accent = value.accent;
  }
  if (typeof value.glyph === 'string' && glyphsById.has(value.glyph)) {
    sanitized.glyph = value.glyph;
  }
  return sanitized;
}

export function parseProjectAppearances(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([rawKey, value]) => {
        const key = normalizeProjectAppearanceKey(rawKey);
        const appearance = sanitizeProjectAppearance(value);
        return key && Object.keys(appearance).length ? [[key, appearance]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function resolveProjectAppearance(project, appearances = {}) {
  const key = normalizeProjectAppearanceKey(project?.root, project?.name);
  const automaticAccent = PROJECT_ACCENTS[
    stableProjectAppearanceHash(key) % PROJECT_ACCENTS.length
  ];
  const stored = sanitizeProjectAppearance(appearances[key]);

  return Object.freeze({
    key,
    accent: accentsById.get(stored.accent) ?? automaticAccent,
    glyph: glyphsById.get(stored.glyph) ?? null,
    customized: Boolean(stored.accent || stored.glyph),
    override: Object.freeze(stored),
  });
}

export function updateProjectAppearance(appearances, rawKey, patch) {
  const key = normalizeProjectAppearanceKey(rawKey);
  if (!key) return { ...(appearances && typeof appearances === 'object' ? appearances : {}) };

  const nextAppearances = { ...(appearances && typeof appearances === 'object' ? appearances : {}) };
  if (patch === null) {
    delete nextAppearances[key];
    return nextAppearances;
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return nextAppearances;
  }

  const next = { ...sanitizeProjectAppearance(nextAppearances[key]) };
  if (hasOwn(patch, 'accent')) {
    if (patch.accent === null) delete next.accent;
    else if (typeof patch.accent === 'string' && accentsById.has(patch.accent)) {
      next.accent = patch.accent;
    }
  }
  if (hasOwn(patch, 'glyph')) {
    if (patch.glyph === null) delete next.glyph;
    else if (typeof patch.glyph === 'string' && glyphsById.has(patch.glyph)) {
      next.glyph = patch.glyph;
    }
  }

  if (Object.keys(next).length) nextAppearances[key] = next;
  else delete nextAppearances[key];
  return nextAppearances;
}
