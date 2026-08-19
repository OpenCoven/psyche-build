import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { describe, expect, it } from 'vitest';

/**
 * Compositor-safety audit for the desktop shell stylesheet.
 *
 * The GPU ADE terminal-rendering slice requires that every animated visual
 * update stays on the compositor: keyframes may only animate `transform` and
 * `opacity`, transitions may only target those same properties, and the
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

const TRANSITION_ALLOWLIST = new Set(['transform', 'opacity']);
const TRANSITION_TIMING_KEYWORDS = new Set([
  'ease',
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'normal',
  'allow-discrete',
]);
const TRANSITION_ALLOWED_FUNCTIONS = new Set(['cubic-bezier', 'steps', 'linear']);

type ValueNode = ReturnType<typeof valueParser>['nodes'][number];

function decodeCssIdentifier(identifier: string): string {
  return identifier.replace(
    /\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\\(\r\n|[\s\S])/g,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      if (hex) {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint === 0 || codePoint > 0x10ffff
          ? '\uFFFD'
          : String.fromCodePoint(codePoint);
      }
      return escaped === '\r\n' || /[\r\n\f]/.test(escaped || '') ? '' : escaped || '';
    },
  );
}

function normalizePropertyName(property: string): string {
  return decodeCssIdentifier(property)
    .toLowerCase()
    .replace(/^-[a-z0-9]+-/, '');
}

function splitValueList(value: string): string[] {
  const segments: ValueNode[][] = [[]];
  for (const node of valueParser(value).nodes) {
    if (node.type === 'div' && node.value === ',') {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(node);
    }
  }
  return segments
    .map((nodes) => valueParser.stringify(nodes).trim())
    .filter(Boolean);
}

function isTransitionTime(token: string): boolean {
  return /^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?m?s$/i.test(token);
}

function resolveCustomProperties(
  value: string,
  customProperties: ReadonlyMap<string, string>,
  resolving = new Set<string>(),
): string {
  const parsed = valueParser(value);
  parsed.walk((node, index, nodes) => {
    if (node.type !== 'function' || normalizePropertyName(node.value) !== 'var') return;
    const separator = node.nodes.findIndex(
      (child) => child.type === 'div' && child.value === ',',
    );
    const name = valueParser.stringify(
      separator === -1 ? node.nodes : node.nodes.slice(0, separator),
    ).trim();
    const fallback = separator === -1
      ? ''
      : valueParser.stringify(node.nodes.slice(separator + 1)).trim();
    const replacement = customProperties.get(name) || fallback;
    if (!replacement || resolving.has(name)) return;
    const nextResolving = new Set(resolving).add(name);
    nodes.splice(
      index,
      1,
      ...valueParser(resolveCustomProperties(replacement, customProperties, nextResolving)).nodes,
    );
  });
  return parsed.toString();
}

function unsupportedTransitionFunctions(value: string): string[] {
  const unsupported: string[] = [];
  valueParser(value).walk((node) => {
    if (
      node.type === 'function'
      && !TRANSITION_ALLOWED_FUNCTIONS.has(normalizePropertyName(node.value))
    ) {
      unsupported.push(valueParser.stringify(node));
    }
  });
  return unsupported;
}

function transitionShorthandProperties(segment: string): string[] {
  const parsed = valueParser(segment);
  const words = parsed.nodes.flatMap((node) => {
    if (node.type === 'word') return [normalizePropertyName(node.value)];
    return [];
  });

  if (words.length === 1 && words[0] === 'none') {
    return [];
  }

  const properties = words.filter(
    (word) => !isTransitionTime(word) && !TRANSITION_TIMING_KEYWORDS.has(word),
  );
  return properties.length > 0 ? properties : ['all'];
}

interface TransitionAnalysis {
  grammarValid: boolean;
  properties: string[];
}

function analyzeTransitionDeclaration(
  property: string,
  value: string,
  customProperties: ReadonlyMap<string, string>,
): TransitionAnalysis {
  const resolved = resolveCustomProperties(value, customProperties);
  const unsupportedFunctions = unsupportedTransitionFunctions(resolved);
  if (property === 'transition') {
    const segments = splitValueList(resolved);
    const segmentProperties = segments.map(transitionShorthandProperties);
    const soleNone = segments.length === 1 && segmentProperties[0].length === 0;
    return {
      grammarValid:
        unsupportedFunctions.length === 0
        && (soleNone || segmentProperties.every((properties) => properties.length === 1)),
      properties: [...unsupportedFunctions, ...segmentProperties.flat()],
    };
  }

  const properties = splitValueList(resolved).map(normalizePropertyName);
  const soleNone = properties.length === 1 && properties[0] === 'none';
  return {
    grammarValid:
      unsupportedFunctions.length === 0
      && (soleNone || !properties.includes('none')),
    properties: soleNone ? unsupportedFunctions : [...unsupportedFunctions, ...properties],
  };
}

function isKeyframesAtRule(atName: string): boolean {
  return /^(?:-[a-z0-9]+-)?keyframes$/.test(atName);
}

function selectorListTargetsTransitioningClass(selectorList: string): boolean {
  let selectorCount = 0;
  let allSelectorsTargetClass = true;

  selectorParser((root) => {
    root.each((selector) => {
      selectorCount += 1;
      let compoundStart = 0;
      selector.nodes.forEach((node, index) => {
        if (node.type === 'combinator') compoundStart = index + 1;
      });
      const targetsClass = selector.nodes
        .slice(compoundStart)
        .some((node) => node.type === 'class' && node.value === 'is-transitioning');
      if (!targetsClass) allSelectorsTargetClass = false;
    });
  }).processSync(selectorList);

  return selectorCount > 0 && allSelectorsTargetClass;
}

function ruleForDeclaration(declaration: Declaration): Rule | null {
  return declaration.parent?.type === 'rule' ? declaration.parent : null;
}

function atRulePrelude(atRule: AtRule): string {
  const separator = atRule.raws.afterName || (atRule.params ? ' ' : '');
  return `@${atRule.name}${separator}${atRule.params}`.trim();
}

interface CompositorFindings {
  keyframeViolations: string[];
  transitionViolations: string[];
  willChangeViolations: string[];
}

function auditStylesheet(css: string): CompositorFindings {
  const root = postcss.parse(css, { from: undefined });
  const customPropertyValues = new Map<string, Set<string>>();
  const ambiguousCustomProperties = new Set<string>();
  root.walkDecls((declaration) => {
    const property = decodeCssIdentifier(declaration.prop);
    if (!property.startsWith('--')) return;
    const rule = ruleForDeclaration(declaration);
    if (
      !rule
      || rule.parent?.type !== 'root'
      || rule.selector.trim() !== ':root'
    ) {
      ambiguousCustomProperties.add(property);
      return;
    }
    const values = customPropertyValues.get(property) ?? new Set<string>();
    values.add(declaration.value);
    customPropertyValues.set(property, values);
  });
  const customProperties = new Map(
    [...customPropertyValues]
      .filter(
        ([property, values]) =>
          values.size === 1 && !ambiguousCustomProperties.has(property),
      )
      .map(([property, values]) => [property, [...values][0]]),
  );
  const findings: CompositorFindings = {
    keyframeViolations: [],
    transitionViolations: [],
    willChangeViolations: [],
  };

  root.walkAtRules((atRule) => {
    const atName = normalizePropertyName(atRule.name);
    if (!isKeyframesAtRule(atName)) return;
    const prelude = atRulePrelude(atRule);
    atRule.walkDecls((declaration) => {
      const property = normalizePropertyName(declaration.prop);
      if (ANIMATABLE_ALLOWLIST.has(property)) return;
      const frame = ruleForDeclaration(declaration);
      findings.keyframeViolations.push(
        `${prelude} { ${frame?.selector || '<unknown>'}: ${property} }`,
      );
    });
  });

  root.walkRules((rule) => {
    const declarations = rule.nodes.filter(
      (node): node is Declaration => node.type === 'decl',
    );
    const duration = declarations.find(
      (declaration) => normalizePropertyName(declaration.prop) === 'transition-duration',
    );
    const definesTransitionProperties = declarations.some((declaration) => {
      const property = normalizePropertyName(declaration.prop);
      return (
        (property === 'transition' || property === 'transition-property')
        && analyzeTransitionDeclaration(
          property,
          declaration.value,
          customProperties,
        ).grammarValid
      );
    });
    if (duration && !definesTransitionProperties) {
      findings.transitionViolations.push(
        `${rule.selector} { ${duration.prop}: all }`,
      );
    }
  });

  root.walkDecls((declaration) => {
    const property = normalizePropertyName(declaration.prop);
    const rule = ruleForDeclaration(declaration);
    const prelude = rule?.selector || '<unknown>';

    if (property === 'transition' || property === 'transition-property') {
      const transition = analyzeTransitionDeclaration(
        property,
        declaration.value,
        customProperties,
      );
      for (const transitionProperty of transition.properties) {
        if (!TRANSITION_ALLOWLIST.has(transitionProperty)) {
          findings.transitionViolations.push(
            `${prelude} { ${declaration.prop}: ${transitionProperty} }`,
          );
        }
      }
    }

    if (
      property === 'will-change'
      && (!rule || !selectorListTargetsTransitioningClass(rule.selector))
    ) {
      findings.willChangeViolations.push(
        `${prelude} { ${declaration.prop}: ${declaration.value} }`,
      );
    }
  });

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

  it('rejects unsafe transition shorthands regardless of token order or function commas', () => {
    const findings = auditStylesheet(`
      .duration-first {
        transition: 200ms width ease;
      }
      .mixed-list {
        transition:
          opacity 120ms cubic-bezier(.2, .8, .2, 1),
          160ms filter linear;
      }
      .all-properties {
        transition: all 120ms ease;
      }
    `);

    expect(findings.transitionViolations).toEqual([
      '.duration-first { transition: width }',
      '.mixed-list { transition: filter }',
      '.all-properties { transition: all }',
    ]);
  });

  it('audits vendor-prefixed transitions and transition-property all', () => {
    const findings = auditStylesheet(`
      .prefixed {
        -webkit-transition: 120ms box-shadow ease;
      }
      .all-properties {
        transition-property: opacity, all;
      }
    `);

    expect(findings.transitionViolations).toEqual([
      '.prefixed { -webkit-transition: box-shadow }',
      '.all-properties { transition-property: all }',
    ]);
  });

  it('allows only transform and opacity transition properties', () => {
    const findings = auditStylesheet(`
      .paint {
        transition:
          transform 120ms ease,
          background 120ms ease,
          color 120ms ease,
          opacity 120ms ease;
      }
      .border {
        transition-property: transform, border-color;
      }
      .disabled {
        transition: none;
      }
      .inherited {
        transition-duration: 120ms;
        transition-property: inherit;
      }
    `);

    expect(findings.transitionViolations).toEqual([
      '.paint { transition: background }',
      '.paint { transition: color }',
      '.border { transition-property: border-color }',
      '.inherited { transition-property: inherit }',
    ]);
  });

  it('rejects duration-only transitions that retain the implicit all property', () => {
    const findings = auditStylesheet(`
      .implicit-all {
        transition-duration: 200ms;
      }
      .explicit-safe {
        transition-property: opacity;
        transition-duration: 200ms;
      }
    `);

    expect(findings.transitionViolations).toEqual([
      '.implicit-all { transition-duration: all }',
    ]);
  });

  it('rejects unresolved custom properties in transition shorthands', () => {
    const findings = auditStylesheet(`
      :root {
        --safe-timing: 120ms ease;
        --unsafe-tail: 120ms ease, background 120ms ease;
        --implicit-tail: 120ms ease, 160ms ease;
        --shadowed-timing: 120ms ease;
      }
      .safe-variable {
        transition: opacity var(--safe-timing);
      }
      .variable-tail {
        transition: opacity var(--rest);
      }
      .expanded-tail {
        transition: opacity var(--unsafe-tail);
      }
      .expanded-implicit {
        transition: opacity var(--implicit-tail);
      }
      .scope {
        --scoped-timing: 120ms ease;
      }
      .shadowed-variable {
        --shadowed-timing: 120ms ease, background 120ms ease;
        transition: opacity var(--shadowed-timing);
      }
      @media (prefers-reduced-motion: no-preference) {
        :root {
          --conditional-timing: 120ms ease;
        }
      }
      .scoped-fallback {
        transition:
          opacity var(--scoped-timing, 120ms ease, background 120ms ease);
      }
      .conditional-fallback {
        transition:
          opacity var(--conditional-timing, 120ms ease, background 120ms ease);
      }
      .environment-fallback {
        transition:
          opacity env(unknown-transition, 120ms ease, background 120ms ease);
      }
    `);

    expect(findings.transitionViolations).toEqual([
      '.variable-tail { transition: var(--rest) }',
      '.expanded-tail { transition: background }',
      '.expanded-implicit { transition: all }',
      '.shadowed-variable { transition: var(--shadowed-timing) }',
      '.scoped-fallback { transition: background }',
      '.conditional-fallback { transition: background }',
      '.environment-fallback { transition: env(unknown-transition, 120ms ease, background 120ms ease) }',
    ]);
  });

  it('does not let invalid transition-property syntax suppress implicit all', () => {
    const findings = auditStylesheet(`
      .invalid-property-list {
        transition-property: none, opacity;
        transition-duration: 200ms;
      }
      .invalid-shorthand {
        transition: opacity bogus();
        transition-duration: 200ms;
      }
    `);

    expect(findings.transitionViolations).toEqual([
      '.invalid-property-list { transition-duration: all }',
      '.invalid-shorthand { transition-duration: all }',
      '.invalid-property-list { transition-property: none }',
      '.invalid-shorthand { transition: bogus() }',
    ]);
  });

  it('preserves comment markers inside strings while parsing later rules', () => {
    const findings = auditStylesheet(`
      .safe::before { content: "/*"; }
      .always-layered { will-change: transform; }
      .safe::after { content: "*/"; }
    `);

    expect(findings.willChangeViolations).toEqual([
      '.always-layered { will-change: transform }',
    ]);
  });

  it('normalizes escaped declaration identifiers before auditing', () => {
    const findings = auditStylesheet(String.raw`
      .paint {
        transit\ion: background 120ms ease;
      }
      .always-layered {
        will-\63hange: transform;
      }
    `);

    expect(findings.transitionViolations).toEqual([
      String.raw`.paint { transit\ion: background }`,
    ]);
    expect(findings.willChangeViolations).toEqual([
      String.raw`.always-layered { will-\63hange: transform }`,
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

  it('only transitions transform and opacity', () => {
    expect(findings.transitionViolations).toEqual([]);
  });

  it('scopes will-change to active .is-transitioning selectors', () => {
    expect(findings.willChangeViolations).toEqual([]);
  });

  it('hints only transform and opacity during active transitions', () => {
    expect(css).toMatch(
      /\.is-transitioning\s*\{\s*will-change:\s*transform,\s*opacity;\s*\}/,
    );
  });
});
