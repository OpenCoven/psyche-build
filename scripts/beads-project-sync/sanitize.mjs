// @ts-check

import os from 'node:os';
import { decodeHTMLStrict } from 'entities';

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
const URL_USERINFO_PATTERN =
  /(?:git\+)?[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\\\s"'`()\[\]{}<>@]+@/iu;
const GENERATED_MARKER_PATTERN = /<!--\s*psyche-bead-sync:v1/giu;
const TOKEN_PATTERN = /\S+/gu;
const URL_TRAILING_PROSE_PUNCTUATION = new Set(['.', ',', ';', '!']);
const URI_WRAPPER_DELIMITERS = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
]);
const HOME_PATH_SEGMENT_CHARACTER_PATTERN = /[A-Za-z0-9._~%-]/u;
const LOCAL_PATH_COMPONENT_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}._~%+@-]/u;
const LOCAL_PATH_FILE_EXTENSION_PATTERN =
  /(?:^|[^.\s])\.[\p{L}\p{N}][\p{L}\p{N}_-]{0,15}$/u;
const LOCAL_PATH_OPENING_DELIMITERS = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
]);
const LOCAL_PATH_CLOSING_DELIMITERS = new Set(
  [...LOCAL_PATH_OPENING_DELIMITERS.values()],
);
const LOCAL_PATH_QUOTE_DELIMITERS = new Set(['"', "'", '`']);
const PROTECTED_URL_PLACEHOLDER_PREFIX = '\u0000psyche-bead-url-';
const PROTECTED_URL_PLACEHOLDER_SUFFIX = '\u0000';
const MAX_URL_CANDIDATE_COUNT = 1_024;
const MAX_URL_CANDIDATE_LENGTH = 16_384;
const MAX_PERCENT_DECODE_ROUNDS = 3;
const MAX_PERCENT_ENCODED_COMPONENT_LENGTH = 16_384;
const MAX_HTML_ENTITY_DECODE_ROUNDS = 3;
const MAX_HTML_ENTITY_INSPECTION_LENGTH = 131_072;
const MAX_HTML_ENTITY_REFERENCE_LENGTH = 64;
const MAX_MARKDOWN_DESTINATION_COUNT = 1_024;
const MAX_MARKDOWN_DESTINATION_LENGTH = 16_384;
const MAX_MARKDOWN_PARENTHESIS_DEPTH = 32;
const INVALID_PERCENT_ESCAPE_PATTERN = /%(?![A-F0-9]{2})/iu;
const VALID_PERCENT_ESCAPE_PATTERN = /%[A-F0-9]{2}/iu;
const MARKDOWN_ESCAPABLE_PUNCTUATION_PATTERN =
  /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/u;
const HTML_ENTITY_REFERENCE_START_PATTERN = /[#A-Za-z]/u;
const HTML_ENTITY_REFERENCE_BODY_PATTERN = /[#A-Za-z0-9]/u;
const HOME_PATH_GENERIC_FILE_URI_PATTERNS = [
  /file:\/\/\/(?:Users|home)\/[^/\\\s"'`()\[\]{}<>;,:]+/gu,
  /file:\/\/\/[A-Za-z]:\/Users\/[^/\\\s"'`()\[\]{}<>;,:]+/gu,
];
const HOME_PATH_GENERIC_PATH_PATTERNS = [
  /[A-Za-z]:(?:\/|\\)Users(?:\/|\\)[^/\\\s"'`()\[\]{}<>;,:]+/gu,
  /(?:\/Users\/[^/\\\s"'`()\[\]{}<>;,:]+|\/home\/[^/\\\s"'`()\[\]{}<>;,:]+)/gu,
];

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
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isAsciiLetter(value) {
  return value != null && /^[A-Za-z]$/u.test(value);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isUriSchemeCharacter(value) {
  return value != null && /^[A-Za-z0-9+.-]$/u.test(value);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isUriCandidateBoundary(value) {
  return value == null || /\s/u.test(value) || (value.codePointAt(0) ?? 0) <= 0x20;
}

/**
 * @typedef {{
 *   start: number,
 *   end: number,
 *   value: string,
 * }} UrlCandidate
 */

/**
 * @param {string} value
 * @param {number} start
 * @returns {number | null}
 */
function findUriSchemeEnd(value, start) {
  if (!isAsciiLetter(value[start])) {
    return null;
  }
  if (start > 0 && isUriSchemeCharacter(value[start - 1])) {
    return null;
  }

  let cursor = start + 1;
  while (isUriSchemeCharacter(value[cursor])) {
    cursor += 1;
  }
  if (value[cursor] !== ':') {
    return null;
  }
  if (
    cursor === start + 1
    && (value[cursor + 1] === '/' || value[cursor + 1] === '\\')
  ) {
    return null;
  }
  return cursor;
}

/**
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function trimUriCandidateEnd(value, start, end) {
  let contentEnd = end;
  while (
    contentEnd > start
    && URL_TRAILING_PROSE_PUNCTUATION.has(value[contentEnd - 1])
    && isUriCandidateBoundary(value[contentEnd])
  ) {
    contentEnd -= 1;
  }

  const wrapperStart = value[start - 1];
  const wrapperEnd = URI_WRAPPER_DELIMITERS.get(wrapperStart);
  if (wrapperEnd != null && value[contentEnd - 1] === wrapperEnd) {
    contentEnd -= 1;
    while (
      contentEnd > start
      && URL_TRAILING_PROSE_PUNCTUATION.has(value[contentEnd - 1])
    ) {
      contentEnd -= 1;
    }
  }

  return contentEnd;
}

/**
 * @param {string} value
 * @returns {UrlCandidate[]}
 */
function scanUrlCandidates(value) {
  const candidates = /** @type {UrlCandidate[]} */ ([]);
  let cursor = 0;

  while (cursor < value.length) {
    const schemeEnd = findUriSchemeEnd(value, cursor);
    if (schemeEnd == null) {
      cursor += 1;
      continue;
    }
    if (candidates.length >= MAX_URL_CANDIDATE_COUNT) {
      fail('Public text exceeds the URL candidate inspection limit');
    }

    const start = cursor;
    let scanEnd = schemeEnd + 1;
    while (scanEnd < value.length && !isUriCandidateBoundary(value[scanEnd])) {
      if (scanEnd - start >= MAX_URL_CANDIDATE_LENGTH) {
        fail('Public URL candidate exceeds the inspection limit');
      }
      scanEnd += 1;
    }

    const contentEnd = Math.max(schemeEnd + 1, trimUriCandidateEnd(value, start, scanEnd));
    candidates.push({
      start,
      end: contentEnd,
      value: value.slice(start, contentEnd),
    });
    cursor = Math.max(contentEnd, schemeEnd + 1);
  }

  return candidates;
}

/**
 * @param {string} value
 * @param {(candidate: string) => string} replace
 * @returns {string}
 */
function replaceUrlCandidates(value, replace) {
  const candidates = scanUrlCandidates(value);
  if (candidates.length === 0) {
    return value;
  }

  let replaced = '';
  let cursor = 0;
  for (const candidate of candidates) {
    replaced += value.slice(cursor, candidate.start);
    replaced += replace(candidate.value);
    cursor = candidate.end;
  }

  return replaced + value.slice(cursor);
}

/**
 * @typedef {{
 *   start: number,
 *   end: number,
 * }} SourceRange
 */

/**
 * @typedef {{
 *   value: string,
 *   sourceRanges: SourceRange[],
 * }} MappedInspectionText
 */

/**
 * @param {string} value
 * @returns {MappedInspectionText}
 */
function createMappedInspectionText(value) {
  if (value.length > MAX_HTML_ENTITY_INSPECTION_LENGTH) {
    fail('Public text exceeds the HTML character reference inspection limit');
  }

  return {
    value,
    sourceRanges: Array.from(
      { length: value.length },
      (_, index) => ({ start: index, end: index + 1 }),
    ),
  };
}

/**
 * @param {MappedInspectionText} mapped
 * @param {number} start
 * @param {number} end
 * @returns {MappedInspectionText}
 */
function sliceMappedInspectionText(mapped, start, end) {
  return {
    value: mapped.value.slice(start, end),
    sourceRanges: mapped.sourceRanges.slice(start, end),
  };
}

/**
 * @param {MappedInspectionText} mapped
 * @param {number} start
 * @param {number} end
 * @returns {SourceRange}
 */
function mappedSourceRange(mapped, start, end) {
  const first = mapped.sourceRanges[start];
  const last = mapped.sourceRanges[end - 1];
  if (first == null || last == null) {
    fail('Invalid public text inspection range');
  }
  return {
    start: first.start,
    end: last.end,
  };
}

/**
 * @param {string[]} output
 * @param {SourceRange[]} sourceRanges
 * @param {string} value
 * @param {SourceRange} sourceRange
 */
function appendMappedInspectionValue(output, sourceRanges, value, sourceRange) {
  output.push(value);
  for (let index = 0; index < value.length; index += 1) {
    sourceRanges.push(sourceRange);
  }
  if (sourceRanges.length > MAX_HTML_ENTITY_INSPECTION_LENGTH) {
    fail('Decoded public text exceeds the HTML character reference inspection limit');
  }
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function markdownFencedCodeMask(value) {
  const mask = new Uint8Array(value.length);
  /** @type {{character: string, length: number} | null} */
  let activeFence = null;
  let lineStart = 0;

  while (lineStart <= value.length) {
    const newlineIndex = value.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    const line = value.slice(lineStart, lineEnd);
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    const isValidOpening = activeFence == null
      && fence != null
      && (fence[1]?.[0] !== '`' || !(fence[2] ?? '').includes('`'));
    const isClosing = activeFence != null
      && fence != null
      && fence[1]?.[0] === activeFence.character
      && (fence[1]?.length ?? 0) >= activeFence.length
      && /^[ \t]*$/u.test(fence[2] ?? '');

    if (activeFence != null || isValidOpening) {
      mask.fill(1, lineStart, newlineIndex === -1 ? lineEnd : lineEnd + 1);
    }
    if (isValidOpening && fence != null) {
      activeFence = {
        character: fence[1]?.[0] ?? '',
        length: fence[1]?.length ?? 0,
      };
    } else if (isClosing) {
      activeFence = null;
    }

    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  return mask;
}

/**
 * @param {string} value
 * @param {Uint8Array} protectedMask
 * @param {number} start
 * @param {number} runLength
 * @returns {number | null}
 */
function findInlineCodeSpanEnd(value, protectedMask, start, runLength) {
  let cursor = start + runLength;
  while (cursor < value.length) {
    if (protectedMask[cursor] || value[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (value[end] === '`' && !protectedMask[end]) {
      end += 1;
    }
    if (end - cursor === runLength) {
      return end;
    }
    cursor = end;
  }
  return null;
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function markdownCodeMask(value) {
  const mask = markdownFencedCodeMask(value);
  let cursor = 0;
  while (cursor < value.length) {
    if (mask[cursor] || value[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (value[runEnd] === '`' && !mask[runEnd]) {
      runEnd += 1;
    }
    const spanEnd = findInlineCodeSpanEnd(value, mask, cursor, runEnd - cursor);
    if (spanEnd == null) {
      cursor = runEnd;
      continue;
    }
    mask.fill(1, cursor, spanEnd);
    cursor = spanEnd;
  }
  return mask;
}

/**
 * @param {MappedInspectionText} mapped
 * @returns {MappedInspectionText}
 */
function decodeMarkdownEscapesMapped(mapped) {
  if (!mapped.value.includes('\\')) {
    return mapped;
  }

  const protectedMask = markdownFencedCodeMask(mapped.value);
  const output = /** @type {string[]} */ ([]);
  const sourceRanges = /** @type {SourceRange[]} */ ([]);
  let cursor = 0;

  while (cursor < mapped.value.length) {
    if (!protectedMask[cursor] && mapped.value[cursor] === '`') {
      let runEnd = cursor + 1;
      while (mapped.value[runEnd] === '`' && !protectedMask[runEnd]) {
        runEnd += 1;
      }
      const spanEnd = findInlineCodeSpanEnd(
        mapped.value,
        protectedMask,
        cursor,
        runEnd - cursor,
      );
      if (spanEnd != null) {
        for (let index = cursor; index < spanEnd; index += 1) {
          appendMappedInspectionValue(
            output,
            sourceRanges,
            mapped.value[index] ?? '',
            mapped.sourceRanges[index] ?? { start: index, end: index + 1 },
          );
        }
        cursor = spanEnd;
        continue;
      }
    }

    const next = mapped.value[cursor + 1];
    if (
      !protectedMask[cursor]
      && mapped.value[cursor] === '\\'
      && next != null
      && MARKDOWN_ESCAPABLE_PUNCTUATION_PATTERN.test(next)
    ) {
      appendMappedInspectionValue(
        output,
        sourceRanges,
        next,
        mappedSourceRange(mapped, cursor, cursor + 2),
      );
      cursor += 2;
      continue;
    }

    appendMappedInspectionValue(
      output,
      sourceRanges,
      mapped.value[cursor] ?? '',
      mapped.sourceRanges[cursor] ?? { start: cursor, end: cursor + 1 },
    );
    cursor += 1;
  }

  return {
    value: output.join(''),
    sourceRanges,
  };
}

/**
 * @param {string} value
 * @param {number} start
 * @returns {number | null}
 */
function findHtmlEntityReferenceEnd(value, start) {
  if (
    value[start] !== '&'
    || !HTML_ENTITY_REFERENCE_START_PATTERN.test(value[start + 1] ?? '')
  ) {
    return null;
  }

  const boundedEnd = Math.min(
    value.length,
    start + MAX_HTML_ENTITY_REFERENCE_LENGTH,
  );
  for (let index = start + 1; index < boundedEnd; index += 1) {
    const character = value[index] ?? '';
    if (character === ';') {
      return index;
    }
    if (!HTML_ENTITY_REFERENCE_BODY_PATTERN.test(character)) {
      return null;
    }
  }
  if (boundedEnd === start + MAX_HTML_ENTITY_REFERENCE_LENGTH) {
    fail('HTML character reference exceeds the inspection limit');
  }

  return null;
}

/**
 * @param {MappedInspectionText} mapped
 * @param {Uint8Array | undefined} [protectedMask]
 * @returns {MappedInspectionText}
 */
function decodeHtmlEntitiesMappedOnce(mapped, protectedMask) {
  if (!mapped.value.includes('&')) {
    return mapped;
  }

  const output = /** @type {string[]} */ ([]);
  const sourceRanges = /** @type {SourceRange[]} */ ([]);
  let cursor = 0;

  while (cursor < mapped.value.length) {
    if (protectedMask?.[cursor]) {
      appendMappedInspectionValue(
        output,
        sourceRanges,
        mapped.value[cursor] ?? '',
        mapped.sourceRanges[cursor] ?? { start: cursor, end: cursor + 1 },
      );
      cursor += 1;
      continue;
    }
    const referenceEnd = findHtmlEntityReferenceEnd(mapped.value, cursor);
    if (referenceEnd == null) {
      appendMappedInspectionValue(
        output,
        sourceRanges,
        mapped.value[cursor] ?? '',
        mapped.sourceRanges[cursor] ?? { start: cursor, end: cursor + 1 },
      );
      cursor += 1;
      continue;
    }

    const reference = mapped.value.slice(cursor, referenceEnd + 1);
    const decoded = decodeHTMLStrict(reference);
    if (decoded === reference) {
      for (let index = cursor; index <= referenceEnd; index += 1) {
        appendMappedInspectionValue(
          output,
          sourceRanges,
          mapped.value[index] ?? '',
          mapped.sourceRanges[index] ?? { start: index, end: index + 1 },
        );
      }
    } else {
      appendMappedInspectionValue(
        output,
        sourceRanges,
        decoded,
        mappedSourceRange(mapped, cursor, referenceEnd + 1),
      );
    }
    cursor = referenceEnd + 1;
  }

  return {
    value: output.join(''),
    sourceRanges,
  };
}

/**
 * @param {MappedInspectionText} mapped
 * @returns {MappedInspectionText}
 */
function decodeHtmlEntitiesMapped(mapped) {
  let current = mapped;

  for (let round = 0; round < MAX_HTML_ENTITY_DECODE_ROUNDS; round += 1) {
    const decoded = decodeHtmlEntitiesMappedOnce(current);
    if (decoded.value === current.value) {
      return current;
    }
    current = decoded;
  }

  if (decodeHtmlEntitiesMappedOnce(current).value !== current.value) {
    fail('HTML character reference exceeds the decoding limit');
  }
  return current;
}

/**
 * @param {MappedInspectionText} mapped
 * @returns {MappedInspectionText}
 */
function decodeMarkdownHtmlEntitiesMapped(mapped) {
  let current = mapped;

  for (let round = 0; round < MAX_HTML_ENTITY_DECODE_ROUNDS; round += 1) {
    const decoded = decodeHtmlEntitiesMappedOnce(
      current,
      markdownCodeMask(current.value),
    );
    if (decoded.value === current.value) {
      return current;
    }
    current = decoded;
  }

  if (
    decodeHtmlEntitiesMappedOnce(current, markdownCodeMask(current.value)).value
    !== current.value
  ) {
    fail('HTML character reference exceeds the decoding limit');
  }
  return current;
}

/**
 * @param {number} byte
 * @returns {number}
 */
function percentEncodedCodePointByteLength(byte) {
  if (byte <= 0x7f) {
    return 1;
  }
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  if (byte >= 0xf0 && byte <= 0xf4) {
    return 4;
  }
  return 0;
}

/**
 * @param {MappedInspectionText} mapped
 * @param {boolean} [allowDecodedLiteralPercent=false]
 * @returns {MappedInspectionText}
 */
function decodePercentMappedOnce(mapped, allowDecodedLiteralPercent = false) {
  if (!mapped.value.includes('%')) {
    return mapped;
  }
  if (mapped.value.length > MAX_PERCENT_ENCODED_COMPONENT_LENGTH) {
    fail('Percent-encoded public URL component exceeds the inspection limit');
  }
  if (INVALID_PERCENT_ESCAPE_PATTERN.test(mapped.value)) {
    if (
      allowDecodedLiteralPercent
      && !VALID_PERCENT_ESCAPE_PATTERN.test(mapped.value)
    ) {
      return mapped;
    }
    fail('Malformed percent encoding in public URL component');
  }
  if (!VALID_PERCENT_ESCAPE_PATTERN.test(mapped.value)) {
    return mapped;
  }

  const output = /** @type {string[]} */ ([]);
  const sourceRanges = /** @type {SourceRange[]} */ ([]);
  let cursor = 0;

  while (cursor < mapped.value.length) {
    if (mapped.value[cursor] !== '%') {
      appendMappedInspectionValue(
        output,
        sourceRanges,
        mapped.value[cursor] ?? '',
        mapped.sourceRanges[cursor] ?? { start: cursor, end: cursor + 1 },
      );
      cursor += 1;
      continue;
    }

    const firstByte = Number.parseInt(mapped.value.slice(cursor + 1, cursor + 3), 16);
    const byteLength = percentEncodedCodePointByteLength(firstByte);
    if (byteLength === 0) {
      fail('Malformed percent encoding in public URL component');
    }

    const encodedEnd = cursor + (byteLength * 3);
    if (encodedEnd > mapped.value.length) {
      fail('Malformed percent encoding in public URL component');
    }
    for (let index = cursor; index < encodedEnd; index += 3) {
      if (
        mapped.value[index] !== '%'
        || !/^[A-F0-9]{2}$/iu.test(mapped.value.slice(index + 1, index + 3))
      ) {
        fail('Malformed percent encoding in public URL component');
      }
    }

    const encoded = mapped.value.slice(cursor, encodedEnd);
    /** @type {string} */
    let decoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      fail('Malformed percent encoding in public URL component');
    }
    appendMappedInspectionValue(
      output,
      sourceRanges,
      decoded,
      mappedSourceRange(mapped, cursor, encodedEnd),
    );
    cursor = encodedEnd;
  }

  return {
    value: output.join(''),
    sourceRanges,
  };
}

/**
 * @param {MappedInspectionText} mapped
 * @returns {MappedInspectionText}
 */
function decodeUrlInspectionMapped(mapped) {
  let current = mapped;

  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    const percentDecoded = decodePercentMappedOnce(current, round > 0);
    const entityDecoded = decodeHtmlEntitiesMappedOnce(percentDecoded);
    if (entityDecoded.value === current.value) {
      return current;
    }
    current = entityDecoded;
  }

  const percentDecoded = decodePercentMappedOnce(current, true);
  const entityDecoded = decodeHtmlEntitiesMappedOnce(percentDecoded);
  if (entityDecoded.value !== current.value) {
    fail('Encoded public URL component exceeds the decoding limit');
  }
  return current;
}

/**
 * @param {MappedInspectionText} mapped
 * @returns {MappedInspectionText}
 */
function normalizeSpecialSchemeSeparatorsMapped(mapped) {
  const schemeEnd = findUriSchemeEnd(mapped.value, 0);
  if (schemeEnd == null) {
    return mapped;
  }
  const scheme = stripGitPlusPrefix(mapped.value.slice(0, schemeEnd)).toLowerCase();
  const hierarchyStart = schemeEnd + 1;
  if (
    (scheme !== 'http' && scheme !== 'https')
    || !mapped.value.includes('\\', hierarchyStart)
  ) {
    return mapped;
  }

  let separatorEnd = hierarchyStart;
  while (mapped.value[separatorEnd] === '/' || mapped.value[separatorEnd] === '\\') {
    separatorEnd += 1;
  }

  const output = /** @type {string[]} */ ([]);
  const sourceRanges = /** @type {SourceRange[]} */ ([]);
  for (let index = 0; index <= schemeEnd; index += 1) {
    appendMappedInspectionValue(
      output,
      sourceRanges,
      mapped.value[index] ?? '',
      mapped.sourceRanges[index] ?? { start: index, end: index + 1 },
    );
  }

  const separatorSourceRange = separatorEnd > hierarchyStart
    ? mappedSourceRange(mapped, hierarchyStart, separatorEnd)
    : mapped.sourceRanges[hierarchyStart]
      ?? mapped.sourceRanges[schemeEnd]
      ?? { start: hierarchyStart, end: hierarchyStart };
  appendMappedInspectionValue(output, sourceRanges, '/', separatorSourceRange);
  appendMappedInspectionValue(output, sourceRanges, '/', separatorSourceRange);

  for (let index = separatorEnd; index < mapped.value.length; index += 1) {
    appendMappedInspectionValue(
      output,
      sourceRanges,
      mapped.value[index] === '\\' ? '/' : mapped.value[index] ?? '',
      mapped.sourceRanges[index] ?? { start: index, end: index + 1 },
    );
  }

  return {
    value: output.join(''),
    sourceRanges,
  };
}

/**
 * @param {MappedInspectionText} mapped
 * @returns {MappedInspectionText}
 */
function inspectUrlCandidateMapped(mapped) {
  return normalizeSpecialSchemeSeparatorsMapped(decodeUrlInspectionMapped(mapped));
}

/**
 * @typedef {{
 *   start: number,
 *   end: number,
 * }} MarkdownDestination
 */

/**
 * @param {MarkdownDestination[]} destinations
 * @param {number} start
 * @param {number} end
 */
function addMarkdownDestination(destinations, start, end) {
  if (end <= start) {
    return;
  }
  if (end - start > MAX_MARKDOWN_DESTINATION_LENGTH) {
    fail('Markdown destination exceeds the inspection limit');
  }
  if (destinations.length >= MAX_MARKDOWN_DESTINATION_COUNT) {
    fail('Public text exceeds the Markdown destination inspection limit');
  }
  if (destinations.some((destination) =>
    destination.start === start && destination.end === end
  )) {
    return;
  }
  destinations.push({ start, end });
}

/**
 * @param {string} value
 * @param {Uint8Array} protectedMask
 * @param {number} start
 * @returns {MarkdownDestination | null}
 */
function parseMarkdownDestinationAt(value, protectedMask, start) {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t' || value[cursor] === '\n') {
    cursor += 1;
  }
  if (cursor >= value.length || protectedMask[cursor]) {
    return null;
  }

  if (value[cursor] === '<') {
    const contentStart = cursor + 1;
    let end = contentStart;
    while (
      end < value.length
      && !protectedMask[end]
      && value[end] !== '>'
      && value[end] !== '\n'
    ) {
      end += 1;
    }
    return value[end] === '>' ? { start: contentStart, end } : null;
  }

  const contentStart = cursor;
  let depth = 0;
  while (cursor < value.length && !protectedMask[cursor]) {
    const character = value[cursor];
    if (character === '(') {
      depth += 1;
      if (depth > MAX_MARKDOWN_PARENTHESIS_DEPTH) {
        fail('Markdown destination exceeds the parenthesis nesting limit');
      }
    } else if (character === ')') {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    } else if (/\s/u.test(character ?? '')) {
      break;
    }
    if (cursor - contentStart >= MAX_MARKDOWN_DESTINATION_LENGTH) {
      fail('Markdown destination exceeds the inspection limit');
    }
    cursor += 1;
  }
  return cursor === contentStart ? null : { start: contentStart, end: cursor };
}

/**
 * @param {string} value
 * @returns {MarkdownDestination[]}
 */
function scanMarkdownDestinations(value) {
  const destinations = /** @type {MarkdownDestination[]} */ ([]);
  const protectedMask = markdownCodeMask(value);

  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (protectedMask[cursor]) {
      continue;
    }
    if (value[cursor] === ']' && value[cursor + 1] === '(') {
      const destination = parseMarkdownDestinationAt(
        value,
        protectedMask,
        cursor + 2,
      );
      if (destination) {
        addMarkdownDestination(destinations, destination.start, destination.end);
      }
      continue;
    }

    if (value[cursor] === '<') {
      const end = value.indexOf('>', cursor + 1);
      if (
        end !== -1
        && end - cursor - 1 <= MAX_MARKDOWN_DESTINATION_LENGTH
        && !value.slice(cursor + 1, end).includes('\n')
        && !protectedMask.slice(cursor, end + 1).some(Boolean)
      ) {
        const content = value.slice(cursor + 1, end);
        if (!/\s/u.test(content) && /[:@%&/\\~.]/u.test(content)) {
          addMarkdownDestination(destinations, cursor + 1, end);
        }
        cursor = end;
      }
    }
  }

  let lineStart = 0;
  while (lineStart <= value.length) {
    const newlineIndex = value.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    if (!protectedMask[lineStart]) {
      const line = value.slice(lineStart, lineEnd);
      const definition = line.match(/^ {0,3}\[[^\]\n]+\]:[ \t]*/u);
      if (definition) {
        const destination = parseMarkdownDestinationAt(
          value,
          protectedMask,
          lineStart + definition[0].length,
        );
        if (destination && destination.end <= lineEnd) {
          addMarkdownDestination(destinations, destination.start, destination.end);
        }
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  return destinations.sort((left, right) => left.start - right.start);
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function percentDecodedVariants(value) {
  const variants = [value];
  if (!value.includes('%')) {
    return variants;
  }
  if (value.length > MAX_PERCENT_ENCODED_COMPONENT_LENGTH) {
    fail('Percent-encoded public URL component exceeds the inspection limit');
  }

  let current = value;
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    if (INVALID_PERCENT_ESCAPE_PATTERN.test(current)) {
      if (round === 0 || VALID_PERCENT_ESCAPE_PATTERN.test(current)) {
        fail('Malformed percent encoding in public URL component');
      }
      break;
    }
    if (!VALID_PERCENT_ESCAPE_PATTERN.test(current)) {
      break;
    }

    /** @type {string} */
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      fail('Malformed percent encoding in public URL component');
    }
    if (decoded === current) {
      break;
    }
    variants.push(decoded);
    current = decoded;
  }

  if (
    VALID_PERCENT_ESCAPE_PATTERN.test(current)
    && !INVALID_PERCENT_ESCAPE_PATTERN.test(current)
  ) {
    fail('Percent-encoded public URL component exceeds the decoding limit');
  }

  return variants;
}

/**
 * @param {string} value
 * @returns {string}
 */
function encodeSanitizedDecodedUrlComponent(value) {
  if (value.includes('<redacted-local-path>')) {
    return '<redacted-local-path>';
  }

  return encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) =>
      `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
    )
    .replace(/%2F/giu, '/');
}

/**
 * @param {string} value
 * @param {(variant: string) => string} sanitize
 * @returns {string}
 */
function sanitizePercentDecodedUrlComponent(value, sanitize) {
  const variants = percentDecodedVariants(value);

  for (const [index, variant] of variants.entries()) {
    const sanitized = sanitize(variant);
    if (sanitized === variant) {
      continue;
    }
    return index === 0
      ? sanitized
      : encodeSanitizedDecodedUrlComponent(sanitized);
  }

  return value;
}

/**
 * @typedef {{
 *   allowGenericFileUriPatterns?: boolean,
 *   allowGenericPathPatterns?: boolean,
 * }} HomeDirectoryRedactionOptions
 */

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @param {HomeDirectoryRedactionOptions} [options={}]
 * @returns {string}
 */
function redactHomeDirectoriesInUrlComponent(value, matchers, options = {}) {
  return sanitizePercentDecodedUrlComponent(
    value,
    (variant) => redactHomeDirectoryToken(variant, matchers, options),
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactLocalOperationalPathsInUrlComponent(value) {
  return sanitizePercentDecodedUrlComponent(value, redactLocalOperationalPaths);
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactEmailsInUrlComponent(value) {
  return sanitizePercentDecodedUrlComponent(
    value,
    (variant) => variant.replace(EMAIL_PATTERN, '<redacted-email>'),
  );
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {boolean}
 */
function containsExactHomeDirectory(value, matchers) {
  const slashNormalized = value.replace(/\\/gu, '/');
  for (const matcher of matchers) {
    if (matcher.replacement !== '~') {
      continue;
    }
    const prefix = matcher.prefix.replace(/\\/gu, '/');
    const caseInsensitive = /^[A-Za-z]:\//u.test(prefix);
    const inspectedValue = caseInsensitive ? slashNormalized.toLowerCase() : slashNormalized;
    const inspectedPrefix = caseInsensitive ? prefix.toLowerCase() : prefix;
    let cursor = 0;
    while (cursor < inspectedValue.length) {
      const start = inspectedValue.indexOf(inspectedPrefix, cursor);
      if (start === -1) {
        break;
      }
      const end = start + inspectedPrefix.length;
      if (
        hasHomePathBoundary(slashNormalized, start)
        && hasHomePathFollower(slashNormalized, end)
      ) {
        return true;
      }
      cursor = start + 1;
    }
  }
  return false;
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeDecodedHttpPathname(value, matchers) {
  if (
    containsExactHomeDirectory(value, matchers)
    || containsLocalOperationalPath(value)
  ) {
    return value.startsWith('/') ? '/<redacted-local-path>' : '<redacted-local-path>';
  }
  return value;
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeHttpPathname(value, matchers) {
  const inspected = decodeUrlInspectionMapped(createMappedInspectionText(value)).value;
  const sanitized = sanitizeDecodedHttpPathname(inspected, matchers);
  if (sanitized !== inspected) {
    return sanitized;
  }
  return redactEmailsInUrlComponent(value);
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeUrlComponent(value, matchers) {
  return redactLocalOperationalPathsInUrlComponent(
    redactHomeDirectoriesInUrlComponent(
      redactEmailsInUrlComponent(value),
      matchers,
      {
        allowGenericFileUriPatterns: true,
        allowGenericPathPatterns: true,
      },
    ),
  );
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
      const sanitizedSegment = sanitizeUrlComponent(segment, matchers);
      if (sanitizedSegment !== segment) {
        changed = true;
      }
      return sanitizedSegment;
    }

    const key = segment.slice(0, separatorIndex);
    const rawValue = segment.slice(separatorIndex + 1);
    const sanitizedKey = sanitizeUrlComponent(key, matchers);
    const sanitizedValue = sanitizeUrlComponent(rawValue, matchers);
    if (sanitizedKey !== key || sanitizedValue !== rawValue) {
      changed = true;
      return `${sanitizedKey}=${sanitizedValue}`;
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
    return sanitizeUrlComponent(value, matchers);
  }

  const rawRoute = value.slice(0, queryIndex);
  const rawQuery = value.slice(queryIndex + 1);
  const sanitizedRoute = sanitizeUrlComponent(rawRoute, matchers);
  const sanitizedQuery = sanitizeUrlQuery(rawQuery, matchers);

  return sanitizedRoute !== rawRoute || sanitizedQuery !== rawQuery
    ? `${sanitizedRoute}?${sanitizedQuery}`
    : value;
}

/**
 * @typedef {{
 *   scheme: string,
 *   authority: { start: number, end: number } | null,
 *   path: { start: number, end: number },
 *   query: { start: number, end: number } | null,
 *   fragment: { start: number, end: number } | null,
 * }} ParsedAbsoluteUri
 */

/**
 * @param {string} value
 * @returns {ParsedAbsoluteUri | null}
 */
function parseAbsoluteUri(value) {
  const schemeEnd = findUriSchemeEnd(value, 0);
  if (schemeEnd == null) {
    return null;
  }
  const scheme = stripGitPlusPrefix(value.slice(0, schemeEnd)).toLowerCase();

  const fragmentDelimiter = value.indexOf('#', schemeEnd + 1);
  const resourceEnd = fragmentDelimiter === -1 ? value.length : fragmentDelimiter;
  const queryDelimiter = value.indexOf('?', schemeEnd + 1);
  const hasQuery = queryDelimiter !== -1 && queryDelimiter < resourceEnd;
  const hierarchyEnd = hasQuery ? queryDelimiter : resourceEnd;
  const hierarchyStart = schemeEnd + 1;
  let pathStart = hierarchyStart;
  let authority = null;

  if (
    (scheme === 'http' || scheme === 'https')
    && (value[hierarchyStart] === '/' || value[hierarchyStart] === '\\')
  ) {
    let authorityStart = hierarchyStart;
    while (value[authorityStart] === '/' || value[authorityStart] === '\\') {
      authorityStart += 1;
    }
    let authorityEnd = authorityStart;
    while (
      authorityEnd < hierarchyEnd
      && value[authorityEnd] !== '/'
      && value[authorityEnd] !== '\\'
    ) {
      authorityEnd += 1;
    }
    authority = {
      start: authorityStart,
      end: authorityEnd,
    };
    pathStart = authorityEnd;
  } else if (value.startsWith('//', hierarchyStart)) {
    const authorityStart = hierarchyStart + 2;
    const slashIndex = value.indexOf('/', authorityStart);
    const authorityEnd = slashIndex === -1 || slashIndex > hierarchyEnd
      ? hierarchyEnd
      : slashIndex;
    authority = {
      start: authorityStart,
      end: authorityEnd,
    };
    pathStart = authorityEnd;
  }

  return {
    scheme,
    authority,
    path: {
      start: pathStart,
      end: hierarchyEnd,
    },
    query: hasQuery
      ? { start: queryDelimiter + 1, end: resourceEnd }
      : null,
    fragment: fragmentDelimiter === -1
      ? null
      : { start: fragmentDelimiter + 1, end: value.length },
  };
}

/**
 * @param {string} value
 * @param {ParsedAbsoluteUri} uri
 * @returns {string}
 */
function stripUriUserinfo(value, uri) {
  if (uri.authority == null) {
    return value;
  }
  const authority = value.slice(uri.authority.start, uri.authority.end);
  const atIndex = authority.lastIndexOf('@');
  if (atIndex === -1) {
    return value;
  }
  const absoluteAtIndex = uri.authority.start + atIndex;
  return `${value.slice(0, uri.authority.start)}${value.slice(absoluteAtIndex + 1)}`;
}

/**
 * @param {string} value
 * @param {{ start: number, end: number } | null} range
 * @param {(component: string) => string} sanitize
 * @returns {{ start: number, end: number, value: string } | null}
 */
function sanitizeUriRange(value, range, sanitize) {
  if (range == null || range.start === range.end) {
    return null;
  }
  const component = value.slice(range.start, range.end);
  const sanitized = sanitize(component);
  return sanitized === component
    ? null
    : { ...range, value: sanitized };
}

/**
 * @param {string} value
 * @param {readonly { start: number, end: number, value: string }[]} replacements
 * @returns {string}
 */
function replaceUriRanges(value, replacements) {
  let replaced = value;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    replaced = `${replaced.slice(0, replacement.start)}${replacement.value}${replaced.slice(replacement.end)}`;
  }
  return replaced;
}

/**
 * @param {string} value
 * @param {ParsedAbsoluteUri} uri
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeParsedUri(value, uri, matchers) {
  const replacements = [];
  const authorityReplacement = sanitizeUriRange(
    value,
    uri.authority,
    (component) => sanitizeUrlComponent(component, matchers),
  );
  if (authorityReplacement?.value.includes('<redacted-local-path>')) {
    return '<redacted-local-path>';
  }
  if (authorityReplacement) {
    replacements.push(authorityReplacement);
  }

  const pathReplacement = sanitizeUriRange(
    value,
    uri.path,
    (component) => {
      const sanitized = uri.scheme === 'http' || uri.scheme === 'https'
        ? sanitizeHttpPathname(component, matchers)
        : sanitizeUrlComponent(component, matchers);
      const structurallyNormalized = uri.authority == null
        ? sanitized.replace(/%3A/giu, ':').replace(/%2C/giu, ',')
        : sanitized;
      return component.startsWith('/') && !structurallyNormalized.startsWith('/')
        ? `/${structurallyNormalized}`
        : structurallyNormalized;
    },
  );
  if (pathReplacement) {
    replacements.push(pathReplacement);
  }

  const queryReplacement = sanitizeUriRange(
    value,
    uri.query,
    (component) => sanitizeUrlQuery(component, matchers),
  );
  if (queryReplacement) {
    replacements.push(queryReplacement);
  }

  const fragmentReplacement = sanitizeUriRange(
    value,
    uri.fragment,
    (component) => sanitizeUrlHash(component, matchers),
  );
  if (fragmentReplacement) {
    replacements.push(fragmentReplacement);
  }

  return replaceUriRanges(value, replacements);
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string | null}
 */
function redactStructurallyDecodedHttpPath(value, matchers) {
  const inspected = inspectUrlCandidateMapped(createMappedInspectionText(value)).value;
  const parsed = parseAbsoluteUri(inspected);
  if (parsed == null || (parsed.scheme !== 'http' && parsed.scheme !== 'https')) {
    return null;
  }
  const withoutUserinfo = stripUriUserinfo(inspected, parsed);
  const uri = parseAbsoluteUri(withoutUserinfo);
  if (uri == null) {
    return null;
  }
  const pathname = withoutUserinfo.slice(uri.path.start, uri.path.end);
  if (
    !containsExactHomeDirectory(pathname, matchers)
    && !containsLocalOperationalPath(pathname)
  ) {
    return null;
  }

  let safePrefix = withoutUserinfo.slice(0, uri.path.start);
  if (uri.authority != null) {
    const authority = withoutUserinfo.slice(uri.authority.start, uri.authority.end);
    const sanitizedAuthority = sanitizeUrlComponent(authority, matchers);
    if (sanitizedAuthority.includes('<redacted-local-path>')) {
      return '<redacted-local-path>';
    }
    safePrefix = `${withoutUserinfo.slice(0, uri.authority.start)}${sanitizedAuthority}`;
  }

  const safePath = pathname.startsWith('/')
    ? '/<redacted-local-path>'
    : '<redacted-local-path>';
  const query = uri.query == null
    ? ''
    : `?${sanitizeUrlQuery(
      withoutUserinfo.slice(uri.query.start, uri.query.end),
      matchers,
    )}`;
  const fragment = uri.fragment == null
    ? ''
    : `#${sanitizeUrlHash(
      withoutUserinfo.slice(uri.fragment.start, uri.fragment.end),
      matchers,
    )}`;
  return `${safePrefix}${safePath}${query}${fragment}`;
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function sanitizeProtectedUrl(value, matchers) {
  const structurallyRedacted = redactStructurallyDecodedHttpPath(value, matchers);
  if (structurallyRedacted != null) {
    return structurallyRedacted;
  }

  for (const [index, variant] of percentDecodedVariants(value).entries()) {
    const uri = parseAbsoluteUri(variant);
    if (uri == null) {
      continue;
    }

    const withoutUserinfo = stripUriUserinfo(variant, uri);
    const reparsed = parseAbsoluteUri(withoutUserinfo);
    if (reparsed == null) {
      return withoutUserinfo;
    }
    const sanitized = sanitizeParsedUri(withoutUserinfo, reparsed, matchers);
    if (index === 0) {
      return sanitized;
    }
    if (sanitized !== variant) {
      return '<redacted-local-path>';
    }
  }

  return value;
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
function protectUrls(value, matchers) {
  const protectedUrls = /** @type {string[]} */ ([]);
  const protectedValue = replaceUrlCandidates(value, (match) => {
    const placeholder = `${PROTECTED_URL_PLACEHOLDER_PREFIX}${protectedUrls.length}${PROTECTED_URL_PLACEHOLDER_SUFFIX}`;
    protectedUrls.push(sanitizeProtectedUrl(match, matchers));
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
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {string}
 */
function redactHomeDirectories(value, matchers) {
  return value.replace(TOKEN_PATTERN, (token) =>
    redactHomeDirectoryToken(token, matchers)
  );
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isLocalPathComponentCharacter(value) {
  return value != null && LOCAL_PATH_COMPONENT_CHARACTER_PATTERN.test(value);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isPathSeparator(value) {
  return value === '/' || value === '\\';
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function hasLocalPathComponentStart(value, index) {
  return (
    index === 0
    || isPathSeparator(value[index - 1])
    || !isLocalPathComponentCharacter(value[index - 1])
  );
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function hasLocalPathComponentEnd(value, index) {
  return (
    index >= value.length
    || isPathSeparator(value[index])
    || !isLocalPathComponentCharacter(value[index])
  );
}

/**
 * @param {string} value
 * @param {string} component
 * @param {number} [fromIndex=0]
 * @returns {number}
 */
function findLocalPathComponent(value, component, fromIndex = 0) {
  const lower = value.toLowerCase();
  let index = lower.indexOf(component, fromIndex);

  while (index >= 0) {
    const end = index + component.length;
    if (
      hasLocalPathComponentStart(value, index)
      && hasLocalPathComponentEnd(value, end)
    ) {
      return index;
    }
    index = lower.indexOf(component, index + 1);
  }

  return -1;
}

/**
 * @param {string} value
 * @param {readonly string[]} components
 * @param {number} [fromIndex=0]
 * @returns {number}
 */
function findLocalPathComponentSequence(value, components, fromIndex = 0) {
  const [firstComponent, ...remainingComponents] = components;
  if (!firstComponent) {
    return -1;
  }

  let start = findLocalPathComponent(value, firstComponent, fromIndex);
  while (start >= 0) {
    let cursor = start + firstComponent.length;
    let matched = true;

    for (const component of remainingComponents) {
      if (!isPathSeparator(value[cursor])) {
        matched = false;
        break;
      }

      cursor += 1;
      const end = cursor + component.length;
      if (
        value.slice(cursor, end).toLowerCase() !== component
        || !hasLocalPathComponentEnd(value, end)
      ) {
        matched = false;
        break;
      }
      cursor = end;
    }

    if (matched) {
      return start;
    }
    start = findLocalPathComponent(value, firstComponent, start + 1);
  }

  return -1;
}

/**
 * @param {string} value
 * @param {number} [fromIndex=0]
 * @returns {number}
 */
function findLocalOperationalPathMarker(value, fromIndex = 0) {
  const candidates = [
    findLocalPathComponent(value, '.worktrees', fromIndex),
    findLocalPathComponentSequence(value, ['.copilot', 'session-state'], fromIndex),
    findLocalPathComponentSequence(value, ['.psyche', 'worktrees'], fromIndex),
  ];

  return candidates
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function containsLocalOperationalPath(value) {
  return findLocalOperationalPathMarker(value) >= 0;
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function isEscapedCharacter(value, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

/**
 * @typedef {{
 *   contentEnd: number,
 * }} LocalPathEnclosure
 */

/**
 * @param {string} value
 * @param {number} pathStart
 * @param {number} markerIndex
 * @returns {LocalPathEnclosure | null}
 */
function findLocalPathEnclosure(value, pathStart, markerIndex) {
  const openingIndex = pathStart - 1;
  const openingDelimiter = value[openingIndex];
  if (
    openingDelimiter == null
    || isEscapedCharacter(value, openingIndex)
  ) {
    return null;
  }

  const closingDelimiter = LOCAL_PATH_OPENING_DELIMITERS.get(openingDelimiter)
    ?? (
      LOCAL_PATH_QUOTE_DELIMITERS.has(openingDelimiter)
        ? openingDelimiter
        : null
    );
  if (!closingDelimiter) {
    return null;
  }

  for (let index = markerIndex; index < value.length && value[index] !== '\n'; index += 1) {
    if (
      value[index] === closingDelimiter
      && !isEscapedCharacter(value, index)
      && !(
        openingDelimiter === "'"
        && isLocalPathComponentCharacter(value[index - 1])
        && isLocalPathComponentCharacter(value[index + 1])
      )
    ) {
      return {
        contentEnd: index,
      };
    }
  }

  return null;
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isLocalPathStartBoundary(value) {
  return (
    value == null
    || /\s/u.test(value)
    || value === '='
    || value === ':'
    || LOCAL_PATH_OPENING_DELIMITERS.has(value)
    || LOCAL_PATH_QUOTE_DELIMITERS.has(value)
  );
}

/**
 * @param {string} value
 * @param {number} pathStart
 * @param {number} markerIndex
 * @returns {boolean}
 */
function isConnectedLocalPathPrefix(value, pathStart, markerIndex) {
  for (let index = pathStart; index < markerIndex; index += 1) {
    if (!/\s/u.test(value[index])) {
      continue;
    }

    let nextContentStart = index;
    while (
      nextContentStart < markerIndex
      && /\s/u.test(value[nextContentStart])
    ) {
      nextContentStart += 1;
    }
    const remainingPrefix = value.slice(nextContentStart, markerIndex);
    if (!remainingPrefix.includes('/') && !remainingPrefix.includes('\\')) {
      return false;
    }
  }

  return true;
}

/**
 * @param {string} value
 * @param {number} lowerBound
 * @param {number} markerIndex
 * @returns {number}
 */
function findExplicitLocalPathStart(value, lowerBound, markerIndex) {
  for (let index = lowerBound; index < markerIndex; index += 1) {
    const character = value[index];
    const previous = value[index - 1];
    const next = value[index + 1];

    if (!isLocalPathStartBoundary(index === lowerBound ? undefined : previous)) {
      continue;
    }
    if (
      (character === '~' && isPathSeparator(next))
      || isPathSeparator(character)
      || (
        /^[A-Za-z]$/u.test(character)
        && value[index + 1] === ':'
        && isPathSeparator(value[index + 2])
      )
      || (
        character === '.'
        && (
          isPathSeparator(next)
          || (next === '.' && isPathSeparator(value[index + 2]))
        )
      )
    ) {
      if (isConnectedLocalPathPrefix(value, index, markerIndex)) {
        return index;
      }
    }
  }

  return -1;
}

/**
 * @param {string} value
 * @param {number} markerIndex
 * @param {number} [lowerBound=0]
 * @returns {number}
 */
function findLocalOperationalPathStart(value, markerIndex, lowerBound = 0) {
  const explicitStart = findExplicitLocalPathStart(value, lowerBound, markerIndex);
  if (explicitStart >= 0) {
    return explicitStart;
  }

  let start = markerIndex;

  while (start > lowerBound) {
    const previous = value[start - 1];
    if (isPathSeparator(previous) || isLocalPathComponentCharacter(previous)) {
      start -= 1;
      continue;
    }
    break;
  }

  return start;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasLikelyLocalPathFileExtension(value) {
  const finalComponent = value.split(/[\\/]/u).at(-1) ?? '';
  return LOCAL_PATH_FILE_EXTENSION_PATTERN.test(finalComponent);
}

/**
 * @param {string} value
 * @param {number} pathStart
 * @param {number} whitespaceStart
 * @param {number} nextContentStart
 * @returns {boolean}
 */
function shouldContinueUnquotedLocalPath(
  value,
  pathStart,
  whitespaceStart,
  nextContentStart,
) {
  let nextContentEnd = nextContentStart;
  while (nextContentEnd < value.length) {
    const character = value[nextContentEnd];
    if (
      /\s/u.test(character)
      || character === ','
      || character === ';'
      || character === '!'
      || character === '?'
      || character === ':'
      || LOCAL_PATH_CLOSING_DELIMITERS.has(character)
    ) {
      break;
    }
    if (
      character === '.'
      && (
        value[nextContentEnd + 1] == null
        || /\s/u.test(value[nextContentEnd + 1])
        || LOCAL_PATH_CLOSING_DELIMITERS.has(value[nextContentEnd + 1])
      )
    ) {
      break;
    }
    nextContentEnd += 1;
  }

  const currentPath = value.slice(pathStart, whitespaceStart);
  const nextContent = value.slice(nextContentStart, nextContentEnd);
  return (
    nextContent.includes('/')
    || nextContent.includes('\\')
    || (
      !hasLikelyLocalPathFileExtension(currentPath)
      && hasLikelyLocalPathFileExtension(nextContent)
    )
  );
}

/**
 * @param {string} value
 * @param {number} pathStart
 * @param {number} markerIndex
 * @returns {number}
 */
function findUnquotedLocalOperationalPathEnd(value, pathStart, markerIndex) {
  let end = markerIndex;

  while (end < value.length) {
    const character = value[end];
    const next = value[end + 1];

    if (character === '\n' || character === '\r') {
      break;
    }
    if (
      character === ','
      || character === ';'
      || character === '!'
      || character === '?'
      || LOCAL_PATH_CLOSING_DELIMITERS.has(character)
      || (
        (character === '.' || character === ':')
        && (
          next == null
          || /\s/u.test(next)
          || LOCAL_PATH_CLOSING_DELIMITERS.has(next)
        )
      )
    ) {
      break;
    }
    if (/\s/u.test(character)) {
      const whitespaceStart = end;
      while (end < value.length && value[end] !== '\n' && /\s/u.test(value[end])) {
        end += 1;
      }
      if (
        end >= value.length
        || value[end] === '\n'
        || !shouldContinueUnquotedLocalPath(value, pathStart, whitespaceStart, end)
      ) {
        return whitespaceStart;
      }
      continue;
    }

    end += 1;
  }

  return end;
}

/**
 * @param {string} value
 * @returns {{ start: number, end: number }[]}
 */
function localOperationalPathRanges(value) {
  const ranges = [];
  let cursor = 0;

  while (cursor < value.length) {
    const markerIndex = findLocalOperationalPathMarker(value, cursor);
    if (markerIndex < 0) {
      break;
    }

    const pathStart = Math.max(
      cursor,
      findLocalOperationalPathStart(value, markerIndex, cursor),
    );
    const enclosure = findLocalPathEnclosure(value, pathStart, markerIndex);
    const pathEnd = enclosure?.contentEnd
      ?? findUnquotedLocalOperationalPathEnd(value, pathStart, markerIndex);
    ranges.push({ start: pathStart, end: pathEnd });
    cursor = pathEnd;
  }

  return ranges;
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactLocalOperationalPaths(value) {
  const ranges = localOperationalPathRanges(value);
  if (ranges.length === 0) {
    return value;
  }

  let sanitized = '';
  let cursor = 0;
  for (const range of ranges) {
    sanitized += `${value.slice(cursor, range.start)}<redacted-local-path>`;
    cursor = range.end;
  }
  return sanitized + value.slice(cursor);
}

/**
 * @typedef {{
 *   start: number,
 *   end: number,
 *   value: string,
 *   priority: number,
 * }} SourceReplacement
 */

/**
 * @param {SourceReplacement[]} replacements
 * @param {string} original
 * @param {MappedInspectionText} mapped
 * @param {number} start
 * @param {number} end
 * @param {string} replacement
 * @param {number} priority
 */
function addMappedSourceReplacement(
  replacements,
  original,
  mapped,
  start,
  end,
  replacement,
  priority,
) {
  if (start >= end) {
    return;
  }
  const sourceRange = mappedSourceRange(mapped, start, end);
  if (
    original.slice(sourceRange.start, sourceRange.end)
    === mapped.value.slice(start, end)
  ) {
    return;
  }
  replacements.push({
    ...sourceRange,
    value: replacement,
    priority,
  });
}

/**
 * @param {string} value
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @returns {{ start: number, end: number, value: string }[]}
 */
function homeDirectoryDecodedRanges(value, matchers) {
  const ranges = [];

  for (const matcher of matchers) {
    let cursor = 0;
    while (cursor < value.length) {
      const start = value.indexOf(matcher.prefix, cursor);
      if (start === -1) {
        break;
      }
      const end = start + matcher.prefix.length;
      if (hasHomePathBoundary(value, start) && hasHomePathFollower(value, end)) {
        ranges.push({ start, end, value: matcher.replacement });
      }
      cursor = start + 1;
    }
  }

  for (const pattern of HOME_PATH_GENERIC_FILE_URI_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? -1;
      if (start < 0) {
        continue;
      }
      const end = start + match[0].length;
      if (hasHomePathBoundary(value, start) && hasHomePathFollower(value, end)) {
        ranges.push({ start, end, value: 'file:///~' });
      }
    }
  }
  for (const pattern of HOME_PATH_GENERIC_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? -1;
      if (start < 0) {
        continue;
      }
      const end = start + match[0].length;
      if (hasHomePathBoundary(value, start) && hasHomePathFollower(value, end)) {
        ranges.push({ start, end, value: '~' });
      }
    }
  }

  return ranges;
}

/**
 * @param {MappedInspectionText} mapped
 * @param {string} original
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @param {SourceReplacement[]} replacements
 */
function collectMappedPathReplacements(mapped, original, matchers, replacements) {
  for (const range of homeDirectoryDecodedRanges(mapped.value, matchers)) {
    addMappedSourceReplacement(
      replacements,
      original,
      mapped,
      range.start,
      range.end,
      range.value,
      1,
    );
  }
  for (const range of localOperationalPathRanges(mapped.value)) {
    addMappedSourceReplacement(
      replacements,
      original,
      mapped,
      range.start,
      range.end,
      '<redacted-local-path>',
      2,
    );
  }
}

/**
 * @param {MappedInspectionText} mapped
 * @param {ParsedAbsoluteUri} uri
 * @param {readonly HomeDirectoryMatcher[]} matchers
 * @param {SourceReplacement[]} replacements
 */
function collectMappedHttpPathnameReplacement(
  mapped,
  uri,
  matchers,
  replacements,
) {
  if (uri.scheme !== 'http' && uri.scheme !== 'https') {
    return;
  }

  const pathname = mapped.value.slice(uri.path.start, uri.path.end);
  const sanitized = sanitizeDecodedHttpPathname(pathname, matchers);
  if (sanitized === pathname) {
    return;
  }

  replacements.push({
    ...mappedSourceRange(mapped, uri.path.start, uri.path.end),
    value: sanitized,
    priority: 4,
  });
}

/**
 * @param {MappedInspectionText} mapped
 * @param {string} original
 * @param {SourceReplacement[]} replacements
 */
function collectMappedEmailReplacements(mapped, original, replacements) {
  EMAIL_PATTERN.lastIndex = 0;
  for (const match of mapped.value.matchAll(EMAIL_PATTERN)) {
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }
    addMappedSourceReplacement(
      replacements,
      original,
      mapped,
      start,
      start + match[0].length,
      '<redacted-email>',
      1,
    );
  }
}

/**
 * @param {string} value
 * @param {SanitizePublicTextConfig | null | undefined} config
 * @returns {string}
 */
function redactDecodedHtmlEntitySensitiveText(value, config) {
  const markdownDecoded = decodeMarkdownEscapesMapped(createMappedInspectionText(value));
  const decoded = decodeMarkdownHtmlEntitiesMapped(markdownDecoded);

  const replacements = /** @type {SourceReplacement[]} */ ([]);
  const matchers = buildHomeDirectoryMatchers(config);
  if (decoded.value !== value) {
    collectMappedEmailReplacements(decoded, value, replacements);

    const candidates = scanUrlCandidates(decoded.value);
    let cursor = 0;
    for (const candidate of candidates) {
      if (candidate.start > cursor) {
        collectMappedPathReplacements(
          sliceMappedInspectionText(decoded, cursor, candidate.start),
          value,
          matchers,
          replacements,
        );
      }

      const inspectedCandidate = inspectUrlCandidateMapped(
        sliceMappedInspectionText(decoded, candidate.start, candidate.end),
      );
      collectMappedEmailReplacements(
        inspectedCandidate,
        value,
        replacements,
      );
      const uri = parseAbsoluteUri(inspectedCandidate.value);
      if (uri != null) {
        if (uri.authority != null) {
          const authority = sliceMappedInspectionText(
            inspectedCandidate,
            uri.authority.start,
            uri.authority.end,
          );
          if (containsLocalOperationalPath(authority.value)) {
            addMappedSourceReplacement(
              replacements,
              value,
              inspectedCandidate,
              0,
              inspectedCandidate.value.length,
              '<redacted-local-path>',
              3,
            );
            cursor = candidate.end;
            continue;
          }
        }

        if (uri.scheme === 'http' || uri.scheme === 'https') {
          collectMappedHttpPathnameReplacement(
            inspectedCandidate,
            uri,
            matchers,
            replacements,
          );
        } else {
          const path = sliceMappedInspectionText(
            inspectedCandidate,
            uri.path.start,
            uri.path.end,
          );
          if (uri.authority == null && containsLocalOperationalPath(path.value)) {
            addMappedSourceReplacement(
              replacements,
              value,
              inspectedCandidate,
              uri.path.start,
              uri.path.end,
              '<redacted-local-path>',
              2,
            );
          } else {
            collectMappedPathReplacements(
              path,
              value,
              matchers,
              replacements,
            );
          }
        }
        if (uri.query != null) {
          collectMappedPathReplacements(
            sliceMappedInspectionText(
              inspectedCandidate,
              uri.query.start,
              uri.query.end,
            ),
            value,
            matchers,
            replacements,
          );
        }
        if (uri.fragment != null) {
          collectMappedPathReplacements(
            sliceMappedInspectionText(
              inspectedCandidate,
              uri.fragment.start,
              uri.fragment.end,
            ),
            value,
            matchers,
            replacements,
          );
        }
      }
      cursor = candidate.end;
    }

    if (cursor < decoded.value.length) {
      collectMappedPathReplacements(
        sliceMappedInspectionText(decoded, cursor, decoded.value.length),
        value,
        matchers,
        replacements,
      );
    }
  }
  for (const destination of scanMarkdownDestinations(markdownDecoded.value)) {
    const inspectedDestination = inspectUrlCandidateMapped(
      sliceMappedInspectionText(
        markdownDecoded,
        destination.start,
        destination.end,
      ),
    );
    assertNoDirectPublishableSecrets(inspectedDestination.value);
    const uri = parseAbsoluteUri(inspectedDestination.value);
    if (uri != null) {
      collectMappedHttpPathnameReplacement(
        inspectedDestination,
        uri,
        matchers,
        replacements,
      );
    } else if (
      (
        containsLocalOperationalPath(inspectedDestination.value)
        || homeDirectoryDecodedRanges(inspectedDestination.value, matchers).length > 0
      )
    ) {
      addMappedSourceReplacement(
        replacements,
        value,
        inspectedDestination,
        0,
        inspectedDestination.value.length,
        '<redacted-local-path>',
        4,
      );
    }
  }
  if (replacements.length === 0) {
    return value;
  }

  const selected = /** @type {SourceReplacement[]} */ ([]);
  for (const replacement of [...replacements].sort((left, right) =>
    right.priority - left.priority
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start
  )) {
    if (selected.some((existing) =>
      replacement.start < existing.end && replacement.end > existing.start
    )) {
      continue;
    }
    selected.push(replacement);
  }

  let sanitized = value;
  for (const replacement of selected.sort((left, right) => right.start - left.start)) {
    sanitized = `${sanitized.slice(0, replacement.start)}${replacement.value}${
      sanitized.slice(replacement.end)
    }`;
  }
  return sanitized;
}

/**
 * @param {string} value
 * @param {SanitizePublicTextConfig | null | undefined} config
 * @returns {string}
 */
function redactLocalPaths(value, config) {
  const matchers = buildHomeDirectoryMatchers(config);
  const { protectedValue, protectedUrls } = protectUrls(value, matchers);
  const sanitized = redactLocalOperationalPaths(
    redactHomeDirectories(protectedValue, matchers),
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
function assertNoDirectPublishableSecrets(value) {
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
  if (URL_USERINFO_PATTERN.test(value)) {
    fail('Publishable URL credentials detected');
  }
}

/**
 * @param {string} value
 * @param {boolean} [rejectDirectUserinfo=false]
 */
function assertNoEncodedUrlSecrets(value, rejectDirectUserinfo = false) {
  const decodedText = decodeHtmlEntitiesMapped(createMappedInspectionText(value));
  if (decodedText.value !== value) {
    assertNoDirectPublishableSecrets(decodedText.value);
  }

  for (const candidate of scanUrlCandidates(decodedText.value)) {
    const mappedCandidate = sliceMappedInspectionText(
      decodedText,
      candidate.start,
      candidate.end,
    );
    const inspectedCandidate = inspectUrlCandidateMapped(mappedCandidate);
    const candidateWasDecoded = inspectedCandidate.value !== candidate.value;
    if (candidateWasDecoded) {
      assertNoDirectPublishableSecrets(inspectedCandidate.value);
    }

    const uri = parseAbsoluteUri(inspectedCandidate.value);
    if (uri == null) {
      continue;
    }

    const components = [
      uri.authority == null
        ? null
        : {
            kind: 'authority',
            value: inspectedCandidate.value.slice(
              uri.authority.start,
              uri.authority.end,
            ),
          },
      {
        kind: 'path',
        value: inspectedCandidate.value.slice(uri.path.start, uri.path.end),
      },
      uri.query == null
        ? null
        : {
            kind: 'query',
            value: inspectedCandidate.value.slice(uri.query.start, uri.query.end),
          },
      uri.fragment == null
        ? null
        : {
            kind: 'fragment',
            value: inspectedCandidate.value.slice(
              uri.fragment.start,
              uri.fragment.end,
            ),
          },
    ].filter((component) => component != null);

    for (const component of components) {
      assertNoDirectPublishableSecrets(component.value);
      if (component.kind !== 'authority') {
        continue;
      }
      const atIndex = component.value.lastIndexOf('@');
      if (atIndex === -1) {
        continue;
      }
      const userinfo = component.value.slice(0, atIndex);
      if (
        rejectDirectUserinfo
        || decodedText.value !== value
        || candidateWasDecoded
        || /[\[\]{}<>"'`\\]/u.test(userinfo)
      ) {
        fail('Publishable URL credentials detected');
      }
    }
  }
}

/**
 * @param {MappedInspectionText} markdownDecoded
 */
function assertNoMarkdownDestinationSecrets(markdownDecoded) {
  for (const destination of scanMarkdownDestinations(markdownDecoded.value)) {
    const inspectedDestination = inspectUrlCandidateMapped(
      sliceMappedInspectionText(
        markdownDecoded,
        destination.start,
        destination.end,
      ),
    );
    assertNoDirectPublishableSecrets(inspectedDestination.value);
  }
}

/**
 * @param {string} value
 */
function assertNoMarkdownReconstructedSecrets(value) {
  const markdownDecoded = decodeMarkdownEscapesMapped(createMappedInspectionText(value));
  if (markdownDecoded.value !== value) {
    const decoded = decodeMarkdownHtmlEntitiesMapped(markdownDecoded);
    assertNoDirectPublishableSecrets(decoded.value);
    assertNoEncodedUrlSecrets(markdownDecoded.value, true);
  }
  assertNoMarkdownDestinationSecrets(markdownDecoded);
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

  assertNoDirectPublishableSecrets(value);
  assertNoEncodedUrlSecrets(value, true);
  assertNoMarkdownReconstructedSecrets(value);
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
  assertNoEncodedUrlSecrets(sanitized);
  assertNoMarkdownReconstructedSecrets(sanitized);
  sanitized = redactDecodedHtmlEntitySensitiveText(sanitized, config);
  sanitized = replaceUrlCandidates(sanitized, (url) => {
    const uri = parseAbsoluteUri(url);
    return uri == null ? url : stripUriUserinfo(url, uri);
  });
  sanitized = sanitized.replace(EMAIL_PATTERN, '<redacted-email>');
  sanitized = redactLocalPaths(sanitized, config);
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
