import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Compositor-safety audit for the desktop shell stylesheet.
 *
 * The GPU ADE terminal-rendering slice requires that every animated visual
 * update stays on the compositor: keyframes may only animate `transform` and
 * `opacity`, transitions may not name layout/paint/filter properties, and the
 * `will-change` hint may only appear while an element is actively transitioning
 * (a `.is-transitioning` selector) so the browser never pins compositor layers
 * for the lifetime of the app.
 *
 * The audit parses the source stylesheet directly rather than trusting a
 * hand-maintained allowlist, so any newly introduced unsafe effect fails here.
 */

const cssPath = join(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/styles.css',
);

const ANIMATABLE_ALLOWLIST = new Set([
  'transform',
  'opacity',
  // Not a rendered property: only shapes the easing curve between keyframes.
  'animation-timing-function',
]);

const FORBIDDEN_TRANSITION_PROPERTIES = [
  'width',
  'height',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'background-position',
  'box-shadow',
  'filter',
  'backdrop-filter',
];

interface Rule {
  prelude: string;
  body: string;
}

/** Strip block comments before structural parsing. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Split a stylesheet (or a nested block body) into `{ prelude, body }` rules by
 * scanning balanced braces. Declarations that precede the first brace at the
 * current level are ignored here; callers that need them read the body.
 */
function splitRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let buffer = '';
  let quote = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (quote) {
      buffer += char;
      if (char === '\\' && i + 1 < text.length) {
        buffer += text[i + 1];
        i += 2;
      } else {
        if (char === quote) quote = '';
        i += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
      i += 1;
      continue;
    }
    if (char === '\\') {
      buffer += char;
      if (i + 1 < text.length) {
        buffer += text[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (char === '{') {
      let depth = 1;
      let bodyQuote = '';
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const bodyChar = text[j];
        if (bodyQuote) {
          if (bodyChar === '\\') j += 1;
          else if (bodyChar === bodyQuote) bodyQuote = '';
        } else if (bodyChar === '"' || bodyChar === "'") {
          bodyQuote = bodyChar;
        } else if (bodyChar === '\\') {
          j += 1;
        } else if (bodyChar === '{') {
          depth += 1;
        } else if (bodyChar === '}') {
          depth -= 1;
        }
        j += 1;
      }
      rules.push({ prelude: buffer.trim(), body: text.slice(i + 1, j - 1) });
      buffer = '';
      i = j;
    } else {
      buffer += char;
      i += 1;
    }
  }
  return rules;
}

/** Parse `prop: value` declarations from a flat block body. */
function parseDeclarations(body: string): Array<{ property: string; value: string }> {
  const declarations: Array<{ property: string; value: string }> = [];
  for (const raw of body.split(';')) {
    const segment = raw.trim();
    if (!segment) continue;
    const colon = segment.indexOf(':');
    if (colon === -1) continue;
    const property = segment.slice(0, colon).trim().toLowerCase();
    const value = segment.slice(colon + 1).trim();
    if (property) declarations.push({ property, value });
  }
  return declarations;
}

/** First identifier of a `transition` shorthand segment is the property. */
function transitionShorthandProperty(segment: string): string {
  const token = segment.trim().split(/\s+/)[0] || '';
  return token.toLowerCase();
}

function isKeyframesAtRule(atName: string): boolean {
  return /^(?:-[a-z0-9]+-)?keyframes$/.test(atName);
}

/** Split a selector list on commas outside attribute and pseudo arguments. */
function splitSelectorList(prelude: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = '';

  for (let i = 0; i < prelude.length; i += 1) {
    const char = prelude[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '\\') {
      i += 1;
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === '(') {
      parenthesisDepth += 1;
    } else if (char === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    } else if (char === ',' && bracketDepth === 0 && parenthesisDepth === 0) {
      selectors.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  }

  selectors.push(prelude.slice(start).trim());
  return selectors;
}

function isCssIdentifierContinuation(char: string): boolean {
  return (
    char === '\\' ||
    /[a-zA-Z0-9_-]/.test(char) ||
    (char.length > 0 && char.charCodeAt(0) >= 0x80)
  );
}

/**
 * Require the rightmost compound selector to name `.is-transitioning`
 * directly. Classes inside attributes, pseudo arguments, or ancestors do not
 * prove that the element receiving `will-change` is actively transitioning.
 */
function selectorTargetsTransitioningClass(selector: string): boolean {
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = '';
  let targetsTransitioningClass = false;

  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (char === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (bracketDepth > 0 || parenthesisDepth > 0) continue;
    if (
      char === '.' &&
      selector.startsWith('.is-transitioning', i) &&
      !isCssIdentifierContinuation(selector[i + '.is-transitioning'.length] || '')
    ) {
      targetsTransitioningClass = true;
      i += '.is-transitioning'.length - 1;
      continue;
    }
    if (/\s|[>+~]/.test(char) || (char === '|' && selector[i + 1] === '|')) {
      targetsTransitioningClass = false;
    }
  }

  return targetsTransitioningClass;
}

function selectorListTargetsTransitioningClass(prelude: string): boolean {
  const selectors = splitSelectorList(prelude);
  return selectors.length > 0 && selectors.every(selectorTargetsTransitioningClass);
}

interface CompositorFindings {
  keyframeViolations: string[];
  transitionViolations: string[];
  willChangeViolations: string[];
}

function auditStylesheet(css: string): CompositorFindings {
  const clean = stripComments(css);
  const findings: CompositorFindings = {
    keyframeViolations: [],
    transitionViolations: [],
    willChangeViolations: [],
  };

  function visit(rules: Rule[]): void {
    for (const rule of rules) {
      const prelude = rule.prelude;
      const atName = prelude.startsWith('@')
        ? prelude.slice(1).split(/[\s({]/)[0].toLowerCase()
        : '';

      if (isKeyframesAtRule(atName)) {
        for (const frame of splitRules(rule.body)) {
          for (const decl of parseDeclarations(frame.body)) {
            if (!ANIMATABLE_ALLOWLIST.has(decl.property)) {
              findings.keyframeViolations.push(
                `${prelude} { ${frame.prelude}: ${decl.property} }`,
              );
            }
          }
        }
        continue;
      }

      // Conditional group at-rules (@media, @supports, @container) nest rules.
      if (atName && rule.body.includes('{')) {
        visit(splitRules(rule.body));
        continue;
      }

      const declarations = parseDeclarations(rule.body);
      for (const decl of declarations) {
        if (decl.property === 'transition' || decl.property === 'transition-property') {
          const names =
            decl.property === 'transition'
              ? decl.value.split(',').map(transitionShorthandProperty)
              : decl.value.split(',').map((token) => token.trim().toLowerCase());
          for (const name of names) {
            if (FORBIDDEN_TRANSITION_PROPERTIES.includes(name)) {
              findings.transitionViolations.push(`${prelude} { ${decl.property}: ${name} }`);
            }
          }
        }
        if (decl.property === 'will-change') {
          if (!selectorListTargetsTransitioningClass(prelude)) {
            findings.willChangeViolations.push(`${prelude} { will-change: ${decl.value} }`);
          }
        }
      }
    }
  }

  visit(splitRules(clean));
  return findings;
}

describe('compositor stylesheet audit parser', () => {
  it('audits standard and vendor-prefixed keyframes case-insensitively', () => {
    const findings = auditStylesheet(`
      @KeYfRaMeS unsafe-standard {
        to { width: 10px; }
      }
      @-WeBkIt-KeYfRaMeS unsafe-prefixed {
        to { filter: blur(2px); }
      }
    `);

    expect(findings.keyframeViolations).toEqual([
      '@KeYfRaMeS unsafe-standard { to: width }',
      '@-WeBkIt-KeYfRaMeS unsafe-prefixed { to: filter }',
    ]);
  });

  it.each([
    ['double-quoted strings', '.always-layered[data-label="{}"]'],
    ['single-quoted strings', ".always-layered[data-label='{}']"],
    [
      'escaped double quotes',
      String.raw`.always-layered[data-label="escaped \" {}"]`,
    ],
    [
      'escaped single quotes',
      String.raw`.always-layered[data-label='escaped \' {}']`,
    ],
  ])('audits braces inside %s', (_description, selector) => {
    const findings = auditStylesheet(`${selector} { will-change: transform; }`);

    expect(findings.willChangeViolations).toEqual([
      `${selector} { will-change: transform }`,
    ]);
  });

  it('audits following rules after braces in quoted declaration values', () => {
    const findings = auditStylesheet(`
      .safe::before { content: "{"; }
      .always-layered { will-change: transform; }
      .safe::after { content: '{'; }
      .also-always-layered { will-change: opacity; }
    `);

    expect(findings.willChangeViolations).toEqual([
      '.always-layered { will-change: transform }',
      '.also-always-layered { will-change: opacity }',
    ]);
  });

  it('accepts selector lists whose selectors target .is-transitioning', () => {
    const selectors = [
      '.button.is-transitioning',
      '.option\\,primary.is-transitioning',
      '.menu > .is-transitioning:hover',
    ].join(',\n');
    const findings = auditStylesheet(`
      ${selectors} {
        will-change: transform;
      }
    `);

    expect(findings.willChangeViolations).toEqual([]);
  });

  it.each([
    [':not(.is-transitioning)', 'a negated class'],
    ['[data-state=".is-transitioning"]', 'an attribute string lookalike'],
    ['.is-transitioning, .always-layered', 'a mixed selector list'],
    ['.is-transitioning .child', 'a transitioning ancestor'],
    ['.is-transitioning\\-lookalike', 'an escaped class-name extension'],
    [':not(.foo\\).is-transitioning)', 'an escaped pseudo argument delimiter'],
  ])('rejects %s because it uses %s', (selector) => {
    const findings = auditStylesheet(`${selector} { will-change: transform; }`);

    expect(findings.willChangeViolations).toEqual([
      `${selector} { will-change: transform }`,
    ]);
  });
});

describe('desktop stylesheet compositor safety', () => {
  const css = readFileSync(cssPath, 'utf8');
  const findings = auditStylesheet(css);

  it('only animates transform and opacity in @keyframes', () => {
    expect(findings.keyframeViolations).toEqual([]);
  });

  it('never transitions layout, paint, or filter properties', () => {
    expect(findings.transitionViolations).toEqual([]);
  });

  it('scopes will-change to active .is-transitioning selectors', () => {
    expect(findings.willChangeViolations).toEqual([]);
  });
});
