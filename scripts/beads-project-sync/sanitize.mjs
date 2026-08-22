// @ts-check

import os from 'node:os';

/** @typedef {import('./model.mjs').ParsedBead} ParsedBead */

/**
 * @typedef {{
 *   homeDirectories?: readonly string[] | ReadonlySet<string>,
 * }} SanitizePublicTextConfig
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description: string | null,
 *   design: string | null,
 *   specId: string | null,
 *   acceptanceCriteria: string | null,
 *   notes: string | null,
 *   status: string,
 *   priority: number,
 *   type: string,
 *   blocked: boolean,
 *   labels: string[],
 *   parentId: string | null,
 *   blockedByIds: string[],
 *   githubAssignee: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   closedAt: string | null,
 * }} PublicBead
 */

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu;
const API_KEY_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|apikey|client[_-]?secret|access[_-]?token|auth[_-]?token)\b(?:\s*["'`])?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;]+)/iu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:github[_-]?token|token|secret|password|passwd)\b(?:\s*["'`])?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;]+)/iu;
const GENERATED_MARKER_PATTERN = /<!--\s*psyche-bead-sync:v1/giu;
const TOKEN_PATTERN = /\S+/gu;
const PROTECTED_URL_PATTERN = /(?:git\+)?[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`()\[\]{}<>]+/gu;
const HOME_PATH_SEGMENT_CHARACTER_PATTERN = /[A-Za-z0-9._~%-]/u;
const PROTECTED_URL_PLACEHOLDER_PREFIX = '\u0000psyche-bead-url-';
const PROTECTED_URL_PLACEHOLDER_SUFFIX = '\u0000';
const HOME_PATH_GENERIC_FILE_URI_PATTERNS = [
  /file:\/\/\/(?:Users|home)\/[^/\\\s"'`()\[\]{}<>;,:]+/gu,
  /file:\/\/\/[A-Za-z]:\/Users\/[^/\\\s"'`()\[\]{}<>;,:]+/gu,
];
const HOME_PATH_GENERIC_PATH_PATTERNS = [
  /(?:\/Users\/[^/\\\s"'`()\[\]{}<>;,:]+|\/home\/[^/\\\s"'`()\[\]{}<>;,:]+)/gu,
  /[A-Za-z]:(?:\/|\\)Users(?:\/|\\)[^/\\\s"'`()\[\]{}<>;,:]+/gu,
];
const URL_PATH_LIKE_QUERY_KEYS = new Set(['path', 'cwd', 'file', 'root', 'worktree']);

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {SanitizePublicTextConfig | null | undefined} config
 * @returns {string[]}
 */
function normalizeHomeDirectories(config) {
  if (config == null) {
    return [os.homedir()].filter(Boolean);
  }

  const { homeDirectories } = config;
  if (homeDirectories == null) {
    return [os.homedir()].filter(Boolean);
  }

  const entries = homeDirectories instanceof Set
    ? [...homeDirectories]
    : Array.isArray(homeDirectories)
      ? homeDirectories
      : fail('sanitizePublicText config.homeDirectories must be an array or Set');

  const normalized = new Set([os.homedir()]);
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      fail('sanitizePublicText config.homeDirectories entries must be strings');
    }

    const homeDirectory = entry.trim().replace(/[\\/]+$/gu, '');
    if (homeDirectory) {
      normalized.add(homeDirectory);
    }
  }

  return [...normalized].filter(Boolean).sort((left, right) => right.length - left.length);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isHomePathSegmentCharacter(value) {
  return value != null && HOME_PATH_SEGMENT_CHARACTER_PATTERN.test(value);
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function hasHomePathBoundary(value, index) {
  if (index <= 0) {
    return true;
  }

  return !isHomePathSegmentCharacter(value[index - 1]);
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function hasHomePathFollower(value, index) {
  const character = value[index];
  return (
    character == null
    || character === '/'
    || character === '\\'
    || !isHomePathSegmentCharacter(character)
  );
}

/**
 * @param {string} homeDirectory
 * @returns {string | null}
 */
function toFileUriHomeDirectory(homeDirectory) {
  if (/^[A-Za-z]:[\\/]/u.test(homeDirectory)) {
    return `file:///${homeDirectory.replace(/\\/gu, '/')}`;
  }
  if (homeDirectory.startsWith('/')) {
    return `file://${homeDirectory}`;
  }
  return null;
}

/**
 * @typedef {{
 *   prefix: string,
 *   replacement: string,
 * }} HomeDirectoryMatcher
 */

/**
 * @param {SanitizePublicTextConfig | null | undefined} config
 * @returns {HomeDirectoryMatcher[]}
 */
function buildHomeDirectoryMatchers(config) {
  const matchers = /** @type {HomeDirectoryMatcher[]} */ ([]);
  for (const homeDirectory of normalizeHomeDirectories(config)) {
    const slashNormalizedHomeDirectory = homeDirectory.replace(/\\/gu, '/');
    const fileUriHomeDirectory = toFileUriHomeDirectory(homeDirectory);
    if (fileUriHomeDirectory) {
      matchers.push({
        prefix: fileUriHomeDirectory,
        replacement: 'file:///~',
      });
    }
    matchers.push({
      prefix: homeDirectory,
      replacement: '~',
    });
    if (slashNormalizedHomeDirectory !== homeDirectory) {
      matchers.push({
        prefix: slashNormalizedHomeDirectory,
        replacement: '~',
      });
    }
  }
  return matchers;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripGitPlusPrefix(value) {
  return value.replace(/^git\+/iu, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function extractAbsoluteUrlBase(value) {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  let end = value.length;

  if (queryIndex !== -1) {
    end = queryIndex;
  }
  if (hashIndex !== -1 && hashIndex < end) {
    end = hashIndex;
  }

  return value.slice(0, end);
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeUrlComponent(value) {
  if (!value) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * @typedef {{
 *   allowGenericFileUriPatterns?: boolean,
 *   allowGenericPathPatterns?: boolean,
 * }} HomeDirectoryRedactionOptions
 */

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPathLikeUrlQueryKey(value) {
  return URL_PATH_LIKE_QUERY_KEYS.has(decodeUrlComponent(value).trim().toLowerCase());
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @param {HomeDirectoryRedactionOptions} [options={}]
 * @returns {string}
 */
function redactHomeDirectoriesInUrlComponent(value, matchers, options = {}) {
  const directlySanitized = redactHomeDirectoryToken(value, matchers, options);
  if (directlySanitized !== value) {
    return directlySanitized;
  }

  const decoded = decodeUrlComponent(value);
  if (decoded === value) {
    return value;
  }

  const decodedSanitized = redactHomeDirectoryToken(decoded, matchers, options);
  return decodedSanitized !== decoded ? decodedSanitized : value;
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeUrlQuery(value, matchers) {
  if (!value) {
    return value;
  }

  let changed = false;
  const sanitized = value.split('&').map((segment) => {
    if (!segment) {
      return segment;
    }

    const separatorIndex = segment.indexOf('=');
    if (separatorIndex === -1) {
      const sanitizedSegment = redactHomeDirectoriesInUrlComponent(segment, matchers, {
        allowGenericFileUriPatterns: true,
        allowGenericPathPatterns: false,
      });
      if (sanitizedSegment !== segment) {
        changed = true;
      }
      return sanitizedSegment;
    }

    const key = segment.slice(0, separatorIndex);
    const rawValue = segment.slice(separatorIndex + 1);
    const sanitizedValue = redactHomeDirectoriesInUrlComponent(rawValue, matchers, {
      allowGenericFileUriPatterns: true,
      allowGenericPathPatterns: isPathLikeUrlQueryKey(key),
    });
    if (sanitizedValue !== rawValue) {
      changed = true;
      return `${key}=${sanitizedValue}`;
    }
    return segment;
  }).join('&');

  return changed ? sanitized : value;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeUrlParameterList(value) {
  return value.includes('=') && !value.startsWith('/');
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeUrlHash(value, matchers) {
  if (!value) {
    return value;
  }

  const queryIndex = value.indexOf('?');
  if (queryIndex === -1) {
    if (looksLikeUrlParameterList(value)) {
      return sanitizeUrlQuery(value, matchers);
    }
    return redactHomeDirectoriesInUrlComponent(value, matchers, {
      allowGenericFileUriPatterns: true,
      allowGenericPathPatterns: false,
    });
  }

  const rawRoute = value.slice(0, queryIndex);
  const rawQuery = value.slice(queryIndex + 1);
  const sanitizedRoute = redactHomeDirectoriesInUrlComponent(rawRoute, matchers, {
    allowGenericFileUriPatterns: true,
    allowGenericPathPatterns: false,
  });
  const sanitizedQuery = sanitizeUrlQuery(rawQuery, matchers);

  return sanitizedRoute !== rawRoute || sanitizedQuery !== rawQuery
    ? `${sanitizedRoute}?${sanitizedQuery}`
    : value;
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function redactHttpUrlHomeDirectoryComponents(value, matchers) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(stripGitPlusPrefix(value));
  } catch {
    return value;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return value;
  }

  let changed = false;

  if (url.search) {
    const rawSearch = url.search.startsWith('?') ? url.search.slice(1) : url.search;
    const sanitizedSearch = sanitizeUrlQuery(rawSearch, matchers);
    if (sanitizedSearch !== rawSearch) {
      url.search = sanitizedSearch;
      changed = true;
    }
  }

  if (url.hash) {
    const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const sanitizedHash = sanitizeUrlHash(rawHash, matchers);
    if (sanitizedHash !== rawHash) {
      url.hash = sanitizedHash;
      changed = true;
    }
  }

  return changed ? `${extractAbsoluteUrlBase(value)}${url.search}${url.hash}` : value;
}

/**
 * @typedef {{
 *   protectedValue: string,
 *   protectedUrls: string[],
 * }} ProtectedUrlState
 */

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {ProtectedUrlState}
 */
function protectNonFileUrls(value, matchers) {
  const protectedUrls = /** @type {string[]} */ ([]);
  const protectedValue = value.replace(PROTECTED_URL_PATTERN, (match) => {
    const scheme = stripGitPlusPrefix(match).split('://', 1)[0]?.toLowerCase();
    if (scheme === 'file') {
      return match;
    }

    const placeholder = `${PROTECTED_URL_PLACEHOLDER_PREFIX}${protectedUrls.length}${PROTECTED_URL_PLACEHOLDER_SUFFIX}`;
    protectedUrls.push(redactHttpUrlHomeDirectoryComponents(match, matchers));
    return placeholder;
  });

  return {
    protectedValue,
    protectedUrls,
  };
}

/**
 * @param {string} value
 * @param {readonly string[]} protectedUrls
 * @returns {string}
 */
function restoreProtectedUrls(value, protectedUrls) {
  let restored = value;

  for (const [index, protectedUrl] of protectedUrls.entries()) {
    restored = restored.replace(
      `${PROTECTED_URL_PLACEHOLDER_PREFIX}${index}${PROTECTED_URL_PLACEHOLDER_SUFFIX}`,
      protectedUrl,
    );
  }

  return restored;
}

/**
 * @param {string} token
 * @param {string} prefix
 * @param {string} replacement
 * @returns {string}
 */
function replaceExactHomePrefix(token, prefix, replacement) {
  if (!prefix) {
    return token;
  }

  let sanitized = '';
  let cursor = 0;
  let changed = false;

  while (cursor < token.length) {
    const start = token.indexOf(prefix, cursor);
    if (start === -1) {
      break;
    }

    const end = start + prefix.length;
    if (hasHomePathBoundary(token, start) && hasHomePathFollower(token, end)) {
      sanitized += token.slice(cursor, start) + replacement;
      cursor = end;
      changed = true;
      continue;
    }

    sanitized += token.slice(cursor, start + 1);
    cursor = start + 1;
  }

  return changed ? sanitized + token.slice(cursor) : token;
}

/**
 * @param {string} token
 * @param {RegExp} pattern
 * @param {string} replacement
 * @returns {string}
 */
function replaceGenericHomePrefixPattern(token, pattern, replacement) {
  pattern.lastIndex = 0;

  let sanitized = '';
  let cursor = 0;
  let changed = false;

  for (const match of token.matchAll(pattern)) {
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }

    const end = start + match[0].length;
    if (!hasHomePathBoundary(token, start) || !hasHomePathFollower(token, end)) {
      continue;
    }

    sanitized += token.slice(cursor, start) + replacement;
    cursor = end;
    changed = true;
  }

  return changed ? sanitized + token.slice(cursor) : token;
}

/**
 * @param {string} token
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @param {HomeDirectoryRedactionOptions} [options={}]
 * @returns {string}
 */
function redactHomeDirectoryToken(token, matchers, options = {}) {
  let sanitized = token;
  const {
    allowGenericFileUriPatterns = true,
    allowGenericPathPatterns = true,
  } = options;

  for (const matcher of matchers) {
    sanitized = replaceExactHomePrefix(sanitized, matcher.prefix, matcher.replacement);
  }
  if (allowGenericFileUriPatterns) {
    for (const pattern of HOME_PATH_GENERIC_FILE_URI_PATTERNS) {
      sanitized = replaceGenericHomePrefixPattern(sanitized, pattern, 'file:///~');
    }
  }
  if (allowGenericPathPatterns) {
    for (const pattern of HOME_PATH_GENERIC_PATH_PATTERNS) {
      sanitized = replaceGenericHomePrefixPattern(sanitized, pattern, '~');
    }
  }

  return sanitized;
}

/**
 * @param {string} value
 * @param {SanitizePublicTextConfig | null | undefined} config
 * @returns {string}
 */
function redactHomeDirectories(value, config) {
  const matchers = buildHomeDirectoryMatchers(config);
  const { protectedValue, protectedUrls } = protectNonFileUrls(value, matchers);
  const sanitized = protectedValue.replace(TOKEN_PATTERN, (token) =>
    redactHomeDirectoryToken(token, matchers)
  );

  return restoreProtectedUrls(sanitized, protectedUrls);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeGeneratedMarkers(value) {
  return value.replace(GENERATED_MARKER_PATTERN, '&lt;!-- psyche-bead-sync:v1');
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function normalizeMultilineText(value) {
  const normalized = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return normalized || null;
}

/**
 * @param {string | null | undefined} value
 * @param {string} fieldName
 * @param {SanitizePublicTextConfig} config
 * @returns {string}
 */
function sanitizeRequiredInlineText(value, fieldName, config) {
  const sanitized = sanitizePublicText(value, config);
  const inline = sanitized == null ? null : sanitized.replace(/\s+/gu, ' ').trim();
  if (!inline) {
    fail(`Public bead field "${fieldName}" must not be empty`);
  }
  return inline;
}

/**
 * @param {string | null | undefined} value
 * @param {string} fieldName
 * @param {SanitizePublicTextConfig} config
 * @returns {string | null}
 */
function sanitizeOptionalInlineText(value, fieldName, config) {
  const sanitized = sanitizePublicText(value, config);
  return sanitized == null ? null : sanitized.replace(/\s+/gu, ' ').trim() || null;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @param {SanitizePublicTextConfig} config
 * @returns {string[]}
 */
function sanitizeStringList(value, fieldName, config) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`Public bead field "${fieldName}" must be an array`);
  }

  const sanitized = /** @type {string[]} */ ([]);
  const seen = new Set();
  for (const entry of value) {
    const item = sanitizeRequiredInlineText(entry, fieldName, config);
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    sanitized.push(item);
  }
  return sanitized;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizePriority(value) {
  const priority = Number(value);
  if (!Number.isFinite(priority)) {
    fail('Public bead field "priority" must be a finite number');
  }
  return priority;
}

/**
 * @param {string} value
 */
export function assertNoPublishableSecrets(value) {
  if (typeof value !== 'string') {
    fail('assertNoPublishableSecrets expected a string');
  }

  if (!value) {
    return;
  }

  if (GITHUB_TOKEN_PATTERN.test(value)) {
    fail('Publishable GitHub token detected');
  }
  if (PRIVATE_KEY_PATTERN.test(value)) {
    fail('Publishable private key detected');
  }
  if (API_KEY_ASSIGNMENT_PATTERN.test(value)) {
    fail('Publishable API key assignment detected');
  }
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(value)) {
    fail('Publishable credential assignment detected');
  }
}

/**
 * @param {string | null | undefined} value
 * @param {SanitizePublicTextConfig} [config={}]
 * @returns {string | null}
 */
export function sanitizePublicText(value, config = {}) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail('sanitizePublicText expected a string when present');
  }

  let sanitized = value.replace(/\r\n?/gu, '\n');
  sanitized = sanitized.replace(EMAIL_PATTERN, '<redacted-email>');
  sanitized = redactHomeDirectories(sanitized, config);
  assertNoPublishableSecrets(sanitized);
  sanitized = escapeGeneratedMarkers(sanitized);
  return normalizeMultilineText(sanitized);
}

/**
 * @param {ParsedBead} bead
 * @param {SanitizePublicTextConfig} [config={}]
 * @returns {PublicBead}
 */
export function toPublicBead(bead, config = {}) {
  if (!bead || typeof bead !== 'object' || Array.isArray(bead)) {
    fail('toPublicBead expected a Beads record object');
  }

  return {
    id: sanitizeRequiredInlineText(bead.id, 'id', config),
    title: sanitizeRequiredInlineText(bead.title, 'title', config),
    description: sanitizePublicText(bead.description, config),
    design: sanitizePublicText(bead.design, config),
    specId: sanitizePublicText(bead.specId, config),
    acceptanceCriteria: sanitizePublicText(bead.acceptanceCriteria, config),
    notes: sanitizePublicText(bead.notes, config),
    status: sanitizeRequiredInlineText(bead.status, 'status', config),
    priority: normalizePriority(bead.priority),
    type: sanitizeRequiredInlineText(bead.type, 'type', config),
    blocked: bead.blocked === true,
    labels: sanitizeStringList(bead.labels, 'labels', config),
    parentId: sanitizeOptionalInlineText(bead.parentId, 'parentId', config),
    blockedByIds: sanitizeStringList(bead.blockedByIds, 'blockedByIds', config),
    githubAssignee: sanitizeOptionalInlineText(bead.githubAssignee, 'githubAssignee', config),
    createdAt: sanitizeRequiredInlineText(bead.createdAt, 'createdAt', config),
    updatedAt: sanitizeRequiredInlineText(bead.updatedAt, 'updatedAt', config),
    closedAt: sanitizeOptionalInlineText(bead.closedAt, 'closedAt', config),
  };
}
