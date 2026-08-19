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

/** Strip block and line comments before structural parsing. */
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
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
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

      if (atName === 'keyframes') {
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
          if (!prelude.includes('.is-transitioning')) {
            findings.willChangeViolations.push(`${prelude} { will-change: ${decl.value} }`);
          }
        }
      }
    }
  }

  visit(splitRules(clean));
  return findings;
}

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
