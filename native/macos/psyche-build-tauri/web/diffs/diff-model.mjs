// One data model behind both diff layouts. Split and stacked are two renderings
// of the same rows, which is what lets the toggle be instant and lets a layout
// switch keep its place: nothing is re-parsed, only re-drawn.

/** A line's role in a hunk. */
const CONTEXT = "context";
const ADD = "add";
const DELETE = "delete";

/**
 * Parse `git diff` output into files → hunks → lines.
 *
 * Only the parts a viewer needs are kept. Mode changes, binary markers and
 * similarity indices are recognised so they cannot be mistaken for content,
 * but they are not modelled: nothing downstream renders them.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;

  const lines = String(text || "").split("\n");
  // A trailing newline yields one empty element; it is an artefact of the
  // split, not a context line, and counting it inflated every row list by one.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const raw of lines) {
    if (raw.startsWith("diff --git")) {
      // "diff --git a/x b/x" — take the b-side, which is the path after a rename.
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = {
        path: match ? match[2] : raw.slice("diff --git ".length),
        oldPath: match ? match[1] : null,
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("Binary files")) { file.binary = true; continue; }
    if (/^(index |old mode |new mode |similarity |rename |new file |deleted file |--- |\+\+\+ )/.test(raw)) {
      continue;
    }

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        heading: header[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    // "\ No newline at end of file" annotates the previous line rather than
    // being one, and counting it would slide every later line number by one.
    if (raw.startsWith("\\")) {
      const previous = hunk.lines[hunk.lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }

    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === "+") hunk.lines.push({ kind: ADD, text: body });
    else if (marker === "-") hunk.lines.push({ kind: DELETE, text: body });
    else if (marker === " " || raw === "") hunk.lines.push({ kind: CONTEXT, text: body });
  }

  // Number the lines once, here, so neither renderer has to track counters.
  for (const entry of files) {
    for (const each of entry.hunks) {
      let oldNo = each.oldStart;
      let newNo = each.newStart;
      for (const line of each.lines) {
        if (line.kind === DELETE) line.oldNo = oldNo++;
        else if (line.kind === ADD) line.newNo = newNo++;
        else { line.oldNo = oldNo++; line.newNo = newNo++; }
      }
    }
  }
  return files;
}

/** Total additions and deletions, for the header's +n −n. */
export function diffStat(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === ADD) additions += 1;
        else if (line.kind === DELETE) deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

/**
 * Word-level segments between a removed and an added line.
 *
 * A common prefix and suffix are trimmed and whatever is left is the change.
 * That is deliberately cruder than a full token diff: it marks the edited span
 * without the false precision of matching stray characters in the middle of an
 * otherwise rewritten line, and it costs one pass instead of a matrix.
 */
export function wordSegments(before, after) {
  const a = String(before ?? "");
  const b = String(after ?? "");
  if (a === b) return { before: [{ text: a }], after: [{ text: b }] };

  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start += 1;
  // Do not let the prefix and suffix overlap on the shorter string.
  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;

  // Grow the span out to token boundaries so a highlight never covers a
  // fragment of a word. Tokens end at whitespace or a structural delimiter,
  // which keeps things like "0.0.1" or a dotted path whole.
  const inToken = (ch) => ch !== undefined && !/[\s"'`,;:(){}\[\]<>]/.test(ch);
  while (start > 0 && inToken(a[start - 1]) && inToken(a[start])) start -= 1;
  const boundary = (text) => {
    let index = text.length - end;
    while (index < text.length && inToken(text[index - 1]) && inToken(text[index])) index += 1;
    return text.length - index;
  };
  const endA = boundary(a);
  const endB = boundary(b);

  const seg = (text, tail) => {
    const head = text.slice(0, start);
    const middle = text.slice(start, text.length - tail);
    const rest = text.slice(text.length - tail);
    const out = [];
    if (head) out.push({ text: head });
    if (middle) out.push({ text: middle, changed: true });
    if (rest) out.push({ text: rest });
    return out.length ? out : [{ text: "" }];
  };
  return { before: seg(a, endA), after: seg(b, endB) };
}

/**
 * Rows for the stacked (unified) layout: every line in order, with both
 * gutters, plus a separator wherever the diff skipped over unchanged lines.
 */
export function stackedRows(file) {
  const rows = [];
  if (!file) return rows;
  let previousOldEnd = null;

  for (const hunk of file.hunks) {
    const skipped = previousOldEnd === null
      ? hunk.oldStart - 1
      : hunk.oldStart - previousOldEnd - 1;
    if (skipped > 0) {
      rows.push({ type: "separator", hidden: skipped, oldStart: previousOldEnd ?? 1, newStart: hunk.newStart });
    }
    const paired = pairAdjacent(hunk.lines);
    for (const line of hunk.lines) {
      const partner = paired.get(line);
      const segments = partner
        ? (line.kind === DELETE
            ? wordSegments(line.text, partner.text).before
            : wordSegments(partner.text, line.text).after)
        : [{ text: line.text }];
      rows.push({ type: "line", kind: line.kind, oldNo: line.oldNo, newNo: line.newNo, segments });
    }
    previousOldEnd = hunk.oldStart + hunk.oldCount - 1;
  }
  return rows;
}

/**
 * Rows for the split layout: removals on the left, additions on the right, and
 * an empty cell opposite a pure add or delete so the two sides stay aligned.
 */
export function splitRows(file) {
  const rows = [];
  if (!file) return rows;
  let previousOldEnd = null;

  for (const hunk of file.hunks) {
    const skipped = previousOldEnd === null
      ? hunk.oldStart - 1
      : hunk.oldStart - previousOldEnd - 1;
    if (skipped > 0) {
      rows.push({ type: "separator", hidden: skipped, oldStart: previousOldEnd ?? 1, newStart: hunk.newStart });
    }

    // Walk the hunk in runs so a block of removals pairs with the block of
    // additions that follows it, rather than each line pairing with whatever
    // happens to be next.
    let index = 0;
    while (index < hunk.lines.length) {
      const line = hunk.lines[index];
      if (line.kind === CONTEXT) {
        rows.push({
          type: "line",
          left: { kind: CONTEXT, no: line.oldNo, segments: [{ text: line.text }] },
          right: { kind: CONTEXT, no: line.newNo, segments: [{ text: line.text }] },
        });
        index += 1;
        continue;
      }
      const removals = [];
      while (index < hunk.lines.length && hunk.lines[index].kind === DELETE) removals.push(hunk.lines[index++]);
      const additions = [];
      while (index < hunk.lines.length && hunk.lines[index].kind === ADD) additions.push(hunk.lines[index++]);

      const height = Math.max(removals.length, additions.length);
      for (let offset = 0; offset < height; offset += 1) {
        const removed = removals[offset];
        const added = additions[offset];
        const pair = removed && added ? wordSegments(removed.text, added.text) : null;
        rows.push({
          type: "line",
          left: removed
            ? { kind: DELETE, no: removed.oldNo, segments: pair ? pair.before : [{ text: removed.text }] }
            : null,
          right: added
            ? { kind: ADD, no: added.newNo, segments: pair ? pair.after : [{ text: added.text }] }
            : null,
        });
      }
    }
    previousOldEnd = hunk.oldStart + hunk.oldCount - 1;
  }
  return rows;
}

/**
 * Match each removal with the addition that replaced it, for word highlights in
 * the stacked layout. Only equal-length runs pair up: when the counts differ the
 * lines are not a rewrite of one another and marking tokens would invent a
 * correspondence that is not there.
 */
function pairAdjacent(lines) {
  const pairs = new Map();
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== DELETE) { index += 1; continue; }
    const removals = [];
    while (index < lines.length && lines[index].kind === DELETE) removals.push(lines[index++]);
    const additions = [];
    while (index < lines.length && lines[index].kind === ADD) additions.push(lines[index++]);
    if (removals.length === additions.length) {
      for (let offset = 0; offset < removals.length; offset += 1) {
        pairs.set(removals[offset], additions[offset]);
        pairs.set(additions[offset], removals[offset]);
      }
    }
  }
  return pairs;
}

export const LINE_KINDS = { CONTEXT, ADD, DELETE };
