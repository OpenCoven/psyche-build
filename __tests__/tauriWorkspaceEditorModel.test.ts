import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const model = await import(
  pathToFileURL(
    join(
      process.cwd(),
      'native/macos/psyche-build-tauri/web/editor/workspace-model.mjs',
    ),
  ).href,
);

describe('Tauri workspace editor model', () => {
  test('selects approved languages from file paths', () => {
    expect(model.languageForPath('component.tsx')).toBe('typescript');
    expect(model.languageForPath('component.ts')).toBe('typescript');
    expect(model.languageForPath('component.jsx')).toBe('javascript');
    expect(model.languageForPath('component.js')).toBe('javascript');
    expect(model.languageForPath('config.json')).toBe('json');
    expect(model.languageForPath('page.html')).toBe('html');
    expect(model.languageForPath('page.xml')).toBe('xml');
    expect(model.languageForPath('styles.css')).toBe('css');
    expect(model.languageForPath('README.md')).toBe('markdown');
    expect(model.languageForPath('script.py')).toBe('python');
    expect(model.languageForPath('main.rs')).toBe('rust');
    expect(model.languageForPath('Dockerfile')).toBe('shell');
    expect(model.languageForPath('Makefile')).toBe('shell');
    expect(model.languageForPath('deploy.sh')).toBe('shell');
    expect(model.languageForPath('config.yaml')).toBe('yaml');
    expect(model.languageForPath('config.yml')).toBe('yaml');
    expect(model.languageForPath('config.toml')).toBe('toml');
    expect(model.languageForPath('unknown.data')).toBe('plain');
  });

  test('tracks file edits and resets its saved baseline', () => {
    const created = model.createFileBuffer('one');
    const updated = model.updateFileBuffer(created, 'two');
    const saved = model.markFileSaved(updated, 'two');

    expect(created).toEqual({ text: 'one', originalText: 'one', dirty: false });
    expect(updated).toEqual({ text: 'two', originalText: 'one', dirty: true });
    expect(saved).toEqual({ text: 'two', originalText: 'two', dirty: false });
  });

  test('suppresses stale request generations', () => {
    const gate = model.createRequestGate();
    const first = gate.next();
    const second = gate.next();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  test('evicts least-recently-used entries and supports deletion and clear', () => {
    const cache = model.createLruCache(2);
    cache.set('first', 1);
    cache.set('second', 2);
    expect(cache.get('first')).toBe(1);
    cache.set('third', 3);

    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('first')).toBe(1);
    expect(cache.get('third')).toBe(3);

    cache.deleteWhere((_value: number, key: string) => key === 'first');
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('third')).toBe(3);

    cache.clear();
    expect(cache.get('third')).toBeUndefined();
  });
});
