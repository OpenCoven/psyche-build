import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const diffsRoot = join(process.cwd(), 'native/macos/psyche-build-tauri/web/diffs');
const model = await import(pathToFileURL(join(diffsRoot, 'diff-model.mjs')).href);
const entry = await import(pathToFileURL(join(diffsRoot, 'diff-entry.js')).href);

const SAMPLE = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@
 {
   "name": "psyche-build",
-  "version": "0.0.1",
+  "version": "0.0.2",
   "type": "module",
 }
`;

describe('diff model', () => {
  test('exposes the whole model through the browser entrypoint', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'LINE_KINDS',
      'diffStat',
      'parseUnifiedDiff',
      'splitRows',
      'stackedRows',
      'wordSegments',
    ]);
  });

  test('parses a file, its hunk header, and numbers both sides', () => {
    const [file] = model.parseUnifiedDiff(SAMPLE);

    expect(file.path).toBe('package.json');
    expect(file.hunks).toHaveLength(1);
    const [hunk] = file.hunks;
    expect({ oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart }).toEqual({
      oldStart: 1, oldCount: 5, newStart: 1,
    });
    const removed = hunk.lines.find((l: any) => l.kind === 'delete');
    const added = hunk.lines.find((l: any) => l.kind === 'add');
    // A removal has an old number only, an addition a new number only.
    expect({ oldNo: removed.oldNo, newNo: removed.newNo }).toEqual({ oldNo: 3, newNo: undefined });
    expect({ oldNo: added.oldNo, newNo: added.newNo }).toEqual({ oldNo: undefined, newNo: 3 });
  });

  test('counts additions and deletions', () => {
    expect(model.diffStat(model.parseUnifiedDiff(SAMPLE))).toEqual({ additions: 1, deletions: 1 });
  });

  test('ignores metadata lines so they cannot be mistaken for content', () => {
    const [file] = model.parseUnifiedDiff(SAMPLE);
    const texts = file.hunks[0].lines.map((l: any) => l.text);
    expect(texts.some((t: string) => t.startsWith('index '))).toBe(false);
    expect(texts.some((t: string) => t.startsWith('--- ') || t.startsWith('+++ '))).toBe(false);
  });

  test('treats "\\ No newline at end of file" as an annotation, not a line', () => {
    const withMarker = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
`;
    const [file] = model.parseUnifiedDiff(withMarker);
    const lines = file.hunks[0].lines;
    // Three real lines, and the numbering is not shifted by the marker.
    expect(lines).toHaveLength(3);
    expect(lines[1].noNewline).toBe(true);
    expect(lines[2].newNo).toBe(2);
  });

  test('flags binary files rather than inventing hunks for them', () => {
    const [file] = model.parseUnifiedDiff(
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    );
    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  describe('word segments', () => {
    test('marks only the span that actually changed', () => {
      const { before, after } = model.wordSegments('  "version": "0.0.1",', '  "version": "0.0.2",');
      expect(before.filter((s: any) => s.changed).map((s: any) => s.text)).toEqual(['0.0.1']);
      expect(after.filter((s: any) => s.changed).map((s: any) => s.text)).toEqual(['0.0.2']);
      // The unchanged head and tail survive, so the line still reads normally.
      expect(before.map((s: any) => s.text).join('')).toBe('  "version": "0.0.1",');
    });

    test('does not start a highlight mid-token', () => {
      const { after } = model.wordSegments('const alpha = 1;', 'const alpine = 1;');
      const changed = after.find((s: any) => s.changed);
      // "alpha"/"alpine" share "alp", but splitting there would highlight a
      // fragment of a word; the span grows out to the token boundary.
      expect(changed.text.startsWith('alp')).toBe(true);
    });

    test('returns a single unchanged segment for identical text', () => {
      const { before, after } = model.wordSegments('same', 'same');
      expect(before).toEqual([{ text: 'same' }]);
      expect(after).toEqual([{ text: 'same' }]);
    });
  });

  describe('stacked rows', () => {
    test('keeps every line in order with both gutters', () => {
      const [file] = model.parseUnifiedDiff(SAMPLE);
      const rows = model.stackedRows(file).filter((r: any) => r.type === 'line');
      expect(rows.map((r: any) => r.kind)).toEqual([
        'context', 'context', 'delete', 'add', 'context', 'context',
      ]);
    });

    test('word-highlights a removal paired with its replacement', () => {
      const [file] = model.parseUnifiedDiff(SAMPLE);
      const rows = model.stackedRows(file);
      const removed = rows.find((r: any) => r.kind === 'delete');
      expect(removed.segments.some((s: any) => s.changed)).toBe(true);
    });

    test('does not pair runs of unequal length', () => {
      // One line replaced by two is not a rewrite of a single line, so marking
      // tokens would invent a correspondence that is not there.
      const uneven = `diff --git a/a.txt b/a.txt
@@ -1,2 +1,3 @@
 keep
-one
+first
+second
`;
      const [file] = model.parseUnifiedDiff(uneven);
      const rows = model.stackedRows(file).filter((r: any) => r.type === 'line');
      for (const row of rows) {
        expect(row.segments.some((s: any) => s.changed)).toBe(false);
      }
    });
  });

  describe('split rows', () => {
    test('puts removals left and additions right on one row', () => {
      const [file] = model.parseUnifiedDiff(SAMPLE);
      const changed = model.splitRows(file).find((r: any) => r.left?.kind === 'delete');
      expect(changed.left.no).toBe(3);
      expect(changed.right.kind).toBe('add');
      expect(changed.right.no).toBe(3);
    });

    test('leaves the opposite cell empty for a pure addition', () => {
      const added = `diff --git a/a.txt b/a.txt
@@ -1,1 +1,2 @@
 keep
+brand new
`;
      const [file] = model.parseUnifiedDiff(added);
      const row = model.splitRows(file).find((r: any) => r.right?.kind === 'add');
      // An empty left cell is what keeps the two columns aligned.
      expect(row.left).toBeNull();
    });

    test('pairs a run of removals with the run of additions after it', () => {
      const block = `diff --git a/a.txt b/a.txt
@@ -1,3 +1,3 @@
-alpha one
-beta two
+alpha ONE
+beta TWO
 tail
`;
      const [file] = model.parseUnifiedDiff(block);
      const rows = model.splitRows(file).filter((r: any) => r.left?.kind === 'delete');
      expect(rows).toHaveLength(2);
      // Pairing is positional within the run, not "whatever line comes next".
      expect(rows[0].right.segments.map((s: any) => s.text).join('')).toBe('alpha ONE');
      expect(rows[1].right.segments.map((s: any) => s.text).join('')).toBe('beta TWO');
    });
  });

  describe('hunk separators', () => {
    test('counts the lines the diff skipped between hunks', () => {
      const twoHunks = `diff --git a/a.txt b/a.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
@@ -30,2 +30,2 @@
 thirty
-thirtyone
+THIRTYONE
`;
      const [file] = model.parseUnifiedDiff(twoHunks);
      for (const rows of [model.stackedRows(file), model.splitRows(file)]) {
        const separators = rows.filter((r: any) => r.type === 'separator');
        // One before the first hunk (lines 1..0 → none) and one between them.
        expect(separators).toHaveLength(1);
        expect(separators[0].hidden).toBe(27);
      }
    });

    test('reports the leading gap when a file does not start at line 1', () => {
      const late = `diff --git a/a.txt b/a.txt
@@ -10,2 +10,2 @@
 ten
-eleven
+ELEVEN
`;
      const [file] = model.parseUnifiedDiff(late);
      const [first] = model.stackedRows(file);
      expect(first.type).toBe('separator');
      expect(first.hidden).toBe(9);
    });
  });

  test('both layouts render the same underlying lines', () => {
    const [file] = model.parseUnifiedDiff(SAMPLE);
    const stackedText = model.stackedRows(file)
      .filter((r: any) => r.type === 'line')
      .map((r: any) => r.segments.map((s: any) => s.text).join(''));
    const splitText = model.splitRows(file)
      .filter((r: any) => r.type === 'line')
      .flatMap((r: any) => [r.left, r.right].filter(Boolean)
        .map((c: any) => c.segments.map((s: any) => s.text).join('')));
    // Split repeats context on both sides; compare as sets of content.
    expect(new Set(splitText)).toEqual(new Set(stackedText));
  });
});
